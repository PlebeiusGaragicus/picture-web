"""photo-web API — library CRUD and image generation (FastAPI)."""

from fastapi import FastAPI

app = FastAPI(title="photo-web", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
