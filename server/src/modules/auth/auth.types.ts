/** 通过 LecSSO 校验后的当前工作室成员身份。 */
export interface AuthUser {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  organizations: string[];
  roles: string[];
  isStudio: boolean;
  isCaptain: boolean;
}
