import 'reflect-metadata';
import { loadAppConfig } from '../config/env.config.js';
import { createStandaloneDataSource } from './data-source.js';

async function run(): Promise<void> {
  const cfg = loadAppConfig();
  const ds = createStandaloneDataSource(cfg);
  await ds.initialize();
  try {
    const executed = await ds.runMigrations();
    console.log(`[migration] 成功执行 ${executed.length} 个迁移`);
  } finally {
    await ds.destroy();
  }
}

run().catch((err) => {
  console.error('[migration] 执行失败:', err);
  process.exit(1);
});
