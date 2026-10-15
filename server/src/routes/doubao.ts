import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { doubaoBrowserInstalled, doubaoLoginInfo, doubaoProfileDir, startDoubaoLogin } from '../doubao';
import { apiError } from './jobs';

export function registerDoubaoRoutes(app: FastifyInstance): void {
  app.get('/api/doubao/status', async () => {
    const { state, error } = doubaoLoginInfo();
    return {
      browserInstalled: doubaoBrowserInstalled(),
      profileExists: fs.existsSync(doubaoProfileDir()),
      loginState: state,
      loginError: error,
    };
  });

  app.post('/api/doubao/login', async () => {
    if (!doubaoBrowserInstalled()) {
      throw apiError(500, 'BROWSER_MISSING', '浏览器组件未安装，请先运行 npx playwright install chromium');
    }
    return startDoubaoLogin();
  });
}
