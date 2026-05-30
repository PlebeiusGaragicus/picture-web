# photo-web

Local development commands for the image lineage canvas app.

For the current product and implementation spec, see [docs/spec.md](docs/spec.md).

## Run Both Servers

```bash
./run
```

This creates or reuses `.venv`, installs Python and web UI dependencies, then starts:

- API: `http://127.0.0.1:8787/api/health`
- UI: `http://127.0.0.1:5173`

Override ports if needed:

```bash
API_PORT=8788 WEB_PORT=5174 ./run
```

## Run Manually

Terminal 1:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r api/requirements.txt
cd api
uvicorn main:app --reload --host 127.0.0.1 --port 8787
```

Terminal 2:

```bash
cd webui
npm install
npm run dev
```

`webui` proxies `/api` to `http://127.0.0.1:8787`.

## Local Secrets

Create `photo-library/.env` with:

```bash
GOOGLE_API_KEY=your-api-key
```
