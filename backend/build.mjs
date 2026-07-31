import { mkdirSync, copyFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = __dirname;
const frontendDist = join(backendDir, 'dist');
const backendDist = frontendDist;

// Frontend is already copied to backend/dist/ via deploy.zip
console.log('[build] Frontend already built and present');
