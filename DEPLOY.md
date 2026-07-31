# Deploying deploy.zip to Hostinger Shared Hosting

## Prerequisites
- Node.js installed (Hostinger usually has Node.js available)
- Playwright browsers installed

## Steps

1. **Upload `deploy.zip`** to your Hostinger public_html or home directory

2. **Unzip**:
   ```bash
   unzip deploy.zip
   cd aylus-backend
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Install Playwright browsers**:
   ```bash
   npx playwright install chromium --with-deps
   ```

5. **Set environment variables** in `.env`:
   ```
   PORT=3001
   GEMINI_API_KEY=your_api_key_here
   PLAYWRIGHT_CHROMIUM_PATH=
   ```

6. **Start the server**:
   ```bash
   node index.js
   ```

## Notes
- Frontend is served from `./dist`
- API routes start with `/api/`
- Browser runs headless