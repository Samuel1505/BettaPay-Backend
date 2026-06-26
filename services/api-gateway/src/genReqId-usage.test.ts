import test from 'tape';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('API Gateway imports and uses shared genReqId utility', (t) => {
  const indexPath = path.resolve(__dirname, './index.ts');
  const content = fs.readFileSync(indexPath, 'utf-8');
  
  t.ok(content.includes('genReqId'), 'index.ts should reference genReqId');
  t.match(content, /import\s+{[^}]*genReqId[^}]*}\s+from\s+['"]@bettapay\/validation['"]/s, 'index.ts should import genReqId from @bettapay/validation');
  t.match(content, /genReqId/s, 'index.ts should reference genReqId in Fastify configuration');
  t.end();
});
