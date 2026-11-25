package api

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/lec-org/lec-orbit/server/internal/auth"
	"github.com/lec-org/lec-orbit/server/internal/config"
	"github.com/lec-org/lec-orbit/server/internal/db"
	"github.com/lec-org/lec-orbit/server/internal/storage"
	"github.com/lec-org/lec-orbit/server/internal/ws"
)

// Use a disposable PostgreSQL database via ORBIT_TEST_POSTGRES_DSN.
func TestMiniAppAuthorLifecycle(t *testing.T) {
	dsn := os.Getenv("ORBIT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set ORBIT_TEST_POSTGRES_DSN to run the workshop integration test")
	}
	gdb, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := gdb.AutoMigrate(&db.MiniApp{}, &db.MiniAppVersion{}, &db.Notification{}, &db.OrbitMember{}); err != nil {
		t.Fatal(err)
	}

	bundles := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(bundles.Close)
	s := &Server{gdb: gdb, hub: ws.NewHub(nil), uploader: storage.NewS3Uploader(config.Config{
		S3Endpoint: bundles.URL, S3PublicBaseURL: bundles.URL, S3Bucket: "test", S3Region: "test",
		S3AccessKey: "test", S3SecretKey: "test",
	})}
	appID := "test-" + uuid.NewString()
	author := appID + "-author"
	t.Cleanup(func() {
		for _, err := range []error{
			gdb.Delete(&db.Notification{}, "target_user_id = ?", author).Error,
			gdb.Delete(&db.MiniAppVersion{}, "app_id = ?", appID).Error,
			gdb.Delete(&db.MiniApp{}, "id = ?", appID).Error,
		} {
			if err != nil {
				t.Error(err)
			}
		}
	})
	now := time.Now().UTC()
	app := db.MiniApp{ID: appID, Name: "Workshop test", Type: "minigame", Engine: "web", OwnerID: author, Status: "published"}
	versions := []db.MiniAppVersion{
		{ID: uuid.New(), AppID: appID, Channel: "release", Status: "approved", Version: "1.0.0", CreatedAt: now.Add(-3 * time.Minute), UploaderID: "author"},
		{ID: uuid.New(), AppID: appID, Channel: "release", Status: "pending", Version: "1.1.0", CreatedAt: now.Add(-2 * time.Minute), UploaderID: "author"},
		{ID: uuid.New(), AppID: appID, Channel: "release", Status: "pending", Version: "1.2.0", CreatedAt: now.Add(-time.Minute), UploaderID: "author"},
		{ID: uuid.New(), AppID: appID, Channel: "preview", Status: "pending", Version: "1.3.0", CreatedAt: now, UploaderID: "author"},
	}
	app.ActiveVersionID = &versions[0].ID
	if err := gdb.Create(&app).Error; err != nil {
		t.Fatal(err)
	}
	for i := range versions {
		versions[i].UploaderID = author
	}
	if err := gdb.Create(&versions).Error; err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	router.Use(func(c *gin.Context) {
		id := c.GetHeader("Test-User")
		c.Set("orbit_auth_user", auth.AuthUser{UserID: id, IsCaptain: id == "captain"})
	})
	router.GET("/apps", s.handleListMiniApps)
	router.GET("/apps/:id", s.handleGetMiniApp)
	router.POST("/apps/upload", s.handleUploadMiniAppBundle)
	router.POST("/apps/:id/status", s.handleUpdateMiniAppStatus)
	router.POST("/apps/:id/versions/:versionId/review", auth.RequireCaptain(), s.handleReviewMiniAppVersion)
	router.POST("/apps/:id/versions/:versionId/withdraw", s.handleWithdrawMiniAppVersion)
	router.POST("/apps/:id/versions/:versionId/resubmit", s.handleResubmitMiniAppVersion)

	serve := func(method, path, actor, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Test-User", actor)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	request := func(method, path, actor, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		res := serve(method, path, actor, body)
		if res.Code != want {
			t.Fatalf("%s %s as %s returned %d, want %d: %s", method, path, actor, res.Code, want, res.Body)
		}
		return res
	}
	list := func(path, actor, wantPendingID string, wantVisible bool) {
		t.Helper()
		res := request(http.MethodGet, path, actor, "", http.StatusOK)
		var catalog struct {
			Items []struct {
				ID             string
				PendingVersion *struct{ ID string }
			}
		}
		if err := json.Unmarshal(res.Body.Bytes(), &catalog); err != nil {
			t.Fatal(err)
		}
		for _, item := range catalog.Items {
			if item.ID != appID {
				continue
			}
			pendingID := ""
			if item.PendingVersion != nil {
				pendingID = item.PendingVersion.ID
			}
			if !wantVisible || pendingID != wantPendingID {
				t.Fatalf("%s as %s returned test app with pending version %q", path, actor, pendingID)
			}
			return
		}
		if wantVisible {
			t.Fatalf("%s as %s omitted test app", path, actor)
		}
	}
	versionPath := func(i int, action string) string {
		return "/apps/" + appID + "/versions/" + versions[i].ID.String() + "/" + action
	}

	list("/apps?pending=1", "captain", versions[2].ID.String(), true)
	list("/apps", "other", "", true)
	request(http.MethodPost, versionPath(2, "withdraw"), "other", "", http.StatusForbidden)
	request(http.MethodPost, versionPath(2, "withdraw"), author, "", http.StatusOK)
	request(http.MethodPost, versionPath(2, "review"), "captain", `{"decision":"approve"}`, http.StatusConflict)
	request(http.MethodPost, versionPath(2, "withdraw"), author, "", http.StatusOK)
	list("/apps?pending=1", "captain", versions[1].ID.String(), true)
	list("/apps", "other", "", true)

	request(http.MethodPost, "/apps/"+appID+"/status", "other", `{"status":"suspended"}`, http.StatusForbidden)
	request(http.MethodPost, "/apps/"+appID+"/status", author, `{"status":"suspended"}`, http.StatusOK)
	request(http.MethodPost, versionPath(1, "review"), "captain", `{"decision":"approve"}`, http.StatusConflict)
	list("/apps?pending=1", "captain", "", false)
	list("/apps", "other", "", false)
	list("/apps", author, "", true)

	var updated db.MiniApp
	if err := gdb.First(&updated, "id = ?", appID).Error; err != nil {
		t.Fatal(err)
	}
	if updated.Status != "suspended" || updated.ActiveVersionID == nil || *updated.ActiveVersionID != versions[0].ID {
		t.Fatalf("downlisting should preserve the active version: %+v", updated)
	}
	for i, want := range []string{"approved", "withdrawn", "withdrawn", "pending"} {
		var ver db.MiniAppVersion
		if err := gdb.First(&ver, "id = ?", versions[i].ID).Error; err != nil || ver.Status != want {
			t.Fatalf("version %s: status %q, want %q, error %v", versions[i].Version, ver.Status, want, err)
		}
	}

	request(http.MethodPost, versionPath(2, "resubmit"), "other", "", http.StatusForbidden)
	request(http.MethodPost, versionPath(3, "resubmit"), author, "", http.StatusConflict)
	res := request(http.MethodPost, versionPath(2, "resubmit"), author, "", http.StatusCreated)
	var retried struct{ VersionID uuid.UUID }
	if err := json.Unmarshal(res.Body.Bytes(), &retried); err != nil {
		t.Fatal(err)
	}
	if retried.VersionID == uuid.Nil || retried.VersionID == versions[2].ID {
		t.Fatal("resubmission must get a fresh review ID")
	}
	var retriedVersion db.MiniAppVersion
	if err := gdb.First(&retriedVersion, "id = ?", retried.VersionID).Error; err != nil {
		t.Fatal(err)
	}
	if retriedVersion.Status != "pending" || retriedVersion.Version != versions[2].Version ||
		retriedVersion.BundleURL != versions[2].BundleURL || retriedVersion.BundleSHA256 != versions[2].BundleSHA256 {
		t.Fatalf("resubmission should reuse the original build: %+v", retriedVersion)
	}
	list("/apps", "other", "", false)
	list("/apps?pending=1", "captain", retried.VersionID.String(), true)
	request(http.MethodPost, versionPath(2, "resubmit"), author, "", http.StatusConflict)
	request(http.MethodPost, versionPath(2, "review"), "captain", `{"decision":"approve"}`, http.StatusConflict)
	request(http.MethodPost, "/apps/"+appID+"/versions/"+retried.VersionID.String()+"/withdraw", author, "", http.StatusOK)

	// A new submission after suspension may be reviewed or withdrawn. Exactly one
	// operation can win, and withdrawing must leave the application suspended.
	replacement := db.MiniAppVersion{
		ID: uuid.New(), AppID: appID, Channel: "release", Status: "pending", Version: "1.4.0", UploaderID: author,
	}
	if err := gdb.Create(&replacement).Error; err != nil {
		t.Fatal(err)
	}
	// A repeated suspension request must leave this later submission alone.
	request(http.MethodPost, "/apps/"+appID+"/status", author, `{"status":"suspended"}`, http.StatusOK)
	list("/apps?pending=1", "captain", replacement.ID.String(), true)
	path := "/apps/" + appID + "/versions/" + replacement.ID.String()
	start := make(chan struct{})
	withdrawResult := make(chan int, 1)
	reviewResult := make(chan int, 1)
	go func() {
		<-start
		withdrawResult <- serve(http.MethodPost, path+"/withdraw", author, "").Code
	}()
	go func() {
		<-start
		reviewResult <- serve(http.MethodPost, path+"/review", "captain", `{"decision":"approve"}`).Code
	}()
	close(start)
	withdrawCode, reviewCode := <-withdrawResult, <-reviewResult
	var final db.MiniApp
	if err := gdb.First(&final, "id = ?", appID).Error; err != nil {
		t.Fatal(err)
	}
	switch {
	case withdrawCode == http.StatusOK && reviewCode == http.StatusConflict:
		if final.Status != "suspended" {
			t.Fatalf("withdrawn replacement changed app status to %q", final.Status)
		}
	case withdrawCode == http.StatusConflict && reviewCode == http.StatusOK:
		if final.Status != "published" || final.ActiveVersionID == nil || *final.ActiveVersionID != replacement.ID {
			t.Fatalf("approved replacement was not published: %+v", final)
		}
	default:
		t.Fatalf("expected one successful transition and one conflict, got withdraw=%d review=%d", withdrawCode, reviewCode)
	}

	request(http.MethodPost, "/apps/"+appID+"/status", author, `{"status":"suspended"}`, http.StatusOK)
	uploadZip := func(manifestID, targetID, version, title string, want int) *httptest.ResponseRecorder {
		t.Helper()
		var bundle bytes.Buffer
		archive := zip.NewWriter(&bundle)
		for name, text := range map[string]string{
			"orbit.manifest.json": fmt.Sprintf(`{"schemaVersion":1,"id":%q,"name":%q,"version":%q,"type":"minigame","engine":"web","entry":"index.html","icon":"icon.svg","description":%q,"tags":[%q]}`, manifestID, title, version, title, version),
			"index.html":          "<html><body>updated</body></html>",
			"icon.svg":            "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
		} {
			entry, err := archive.Create(name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := entry.Write([]byte(text)); err != nil {
				t.Fatal(err)
			}
		}
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		if err := form.WriteField("targetAppId", targetID); err != nil {
			t.Fatal(err)
		}
		if err := form.WriteField("channel", "release"); err != nil {
			t.Fatal(err)
		}
		file, err := form.CreateFormFile("file", "update.zip")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(bundle.Bytes()); err != nil {
			t.Fatal(err)
		}
		if err := form.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/apps/upload", &body)
		req.Header.Set("Content-Type", form.FormDataContentType())
		req.Header.Set("Test-User", author)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("upload returned %d, want %d: %s", res.Code, want, res.Body)
		}
		return res
	}
	uploadZip("different-work-"+uuid.NewString(), appID, "2.0.0", "Workshop test", http.StatusBadRequest)
	uploaded := uploadZip(appID, appID, "2.0.0", "Workshop test", http.StatusCreated)
	var item miniAppCatalogDTO
	if err := json.Unmarshal(uploaded.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if item.ID != appID || item.Status != "suspended" || item.PendingVersion == nil || item.PendingVersion.Version != "2.0.0" {
		t.Fatalf("replacement should be one pending version under the same suspended app: %+v", item)
	}
	uploadZip(appID, appID, "2.0.0", "Workshop test", http.StatusConflict)
	list("/apps", "other", "", false)
	request(http.MethodPost, "/apps/"+appID+"/versions/"+item.PendingVersion.ID+"/review", "captain", `{"decision":"approve"}`, http.StatusOK)
	list("/apps", "other", "", true)
	var publicWork db.MiniApp
	if err := gdb.First(&publicWork, "id = ?", appID).Error; err != nil {
		t.Fatal(err)
	}
	if publicWork.Status != "published" || publicWork.ActiveVersionID == nil || publicWork.ActiveVersionID.String() != item.PendingVersion.ID {
		t.Fatalf("approval must publish the replacement in place: %+v", publicWork)
	}
	request(http.MethodPost, "/apps/"+appID+"/status", author, `{"status":"suspended"}`, http.StatusOK)
	ownerCatalog := request(http.MethodGet, "/apps?mine=1", author, "", http.StatusOK)
	var ownWorks struct{ Items []miniAppCatalogDTO }
	if err := json.Unmarshal(ownerCatalog.Body.Bytes(), &ownWorks); err != nil {
		t.Fatal(err)
	}
	if len(ownWorks.Items) != 1 || ownWorks.Items[0].RecoveryVersion == nil ||
		ownWorks.Items[0].RecoveryVersion.ID != item.PendingVersion.ID {
		t.Fatalf("the author should see one work and recover its most recent approved version: %+v", ownWorks.Items)
	}
	recovered := request(http.MethodPost, "/apps/"+appID+"/versions/"+item.PendingVersion.ID+"/resubmit", author, "", http.StatusCreated)
	list("/apps", "other", "", false)
	var recovery struct{ VersionID string }
	if err := json.Unmarshal(recovered.Body.Bytes(), &recovery); err != nil {
		t.Fatal(err)
	}
	reviewPath := func(id string) string { return "/apps/" + appID + "/versions/" + id + "/review" }
	request(http.MethodPost, reviewPath(recovery.VersionID), "captain", `{"decision":"approve"}`, http.StatusOK)

	publicCard := func() miniAppCatalogDTO {
		t.Helper()
		res := request(http.MethodGet, "/apps", "other", "", http.StatusOK)
		var catalog struct{ Items []miniAppCatalogDTO }
		if err := json.Unmarshal(res.Body.Bytes(), &catalog); err != nil {
			t.Fatal(err)
		}
		for _, card := range catalog.Items {
			if card.ID == appID {
				return card
			}
		}
		t.Fatal("published work missing from catalog")
		return miniAppCatalogDTO{}
	}
	older := publicCard()
	readPendingID := func(response *httptest.ResponseRecorder) string {
		t.Helper()
		var uploaded miniAppCatalogDTO
		if err := json.Unmarshal(response.Body.Bytes(), &uploaded); err != nil {
			t.Fatal(err)
		}
		if uploaded.PendingVersion == nil {
			t.Fatal("upload omitted pending version")
		}
		return uploaded.PendingVersion.ID
	}
	staleID := readPendingID(uploadZip(appID, appID, "2.1.0", "Older candidate", http.StatusCreated))
	newID := readPendingID(uploadZip(appID, "", "2.2.0", "New title", http.StatusCreated))
	whilePending := publicCard()
	if whilePending.Name != older.Name || whilePending.Description != older.Description ||
		whilePending.IconURL != older.IconURL || strings.Join(whilePending.Tags, ",") != strings.Join(older.Tags, ",") ||
		whilePending.ActiveVersion == nil || whilePending.ActiveVersion.ID != recovery.VersionID {
		t.Fatalf("pending builds modified the published card: before=%+v during=%+v", older, whilePending)
	}
	detailResponse := request(http.MethodGet, "/apps/"+appID, "other", "", http.StatusOK)
	var detail miniAppDetailDTO
	if err := json.Unmarshal(detailResponse.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Name != older.Name || detail.IconURL != older.IconURL || detail.PendingVersion != nil {
		t.Fatalf("public detail exposed pending metadata: %+v", detail.miniAppCatalogDTO)
	}
	request(http.MethodPost, reviewPath(newID), "captain", `{"decision":"approve"}`, http.StatusOK)
	request(http.MethodPost, reviewPath(staleID), "captain", `{"decision":"approve"}`, http.StatusConflict)
	var superseded db.MiniAppVersion
	if err := gdb.First(&superseded, "id = ?", staleID).Error; err != nil || superseded.Status != "superseded" {
		t.Fatalf("older release should be retained as superseded, got %q: %v", superseded.Status, err)
	}
	legacy := db.MiniAppVersion{ID: uuid.New(), AppID: appID, Channel: "release", Status: "pending",
		Version: "1.9.0", UploaderID: author, CreatedAt: now.Add(-time.Hour)}
	if err := gdb.Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	request(http.MethodPost, reviewPath(legacy.ID.String()), "captain", `{"decision":"approve"}`, http.StatusConflict)
	list("/apps?pending=1", "captain", "", false)
	after := publicCard()
	if after.Name != "New title" || after.Description != "New title" || after.IconURL == older.IconURL ||
		strings.Join(after.Tags, ",") != "2.2.0" || after.ActiveVersion == nil || after.ActiveVersion.ID != newID {
		t.Fatalf("approval did not move the version and card metadata together: %+v", after)
	}
	if err := gdb.Model(&db.MiniApp{}).Where("id = ?", appID).Updates(map[string]any{
		"name": "Legacy pending title", "description": "Legacy pending description", "engine": "unity", "type": "miniapp",
	}).Error; err != nil {
		t.Fatal(err)
	}
	list("/apps?q=New%20title&type=minigame&engine=web", "other", "", true)
	list("/apps?q=New%20title&type=minigame&engine=unity", "other", "", false)
	list("/apps?q=Legacy%20pending", "other", "", false)
	list("/apps?engine=unity", "other", "", false)
	request(http.MethodPost, "/apps/"+appID+"/status", author, `{"status":"suspended"}`, http.StatusOK)
	list("/apps?q=New%20title", "other", "", false)
}
