from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)

app.mount("/site/", StaticFiles(directory="./site/"), name="site")
app.mount("/stream/", StaticFiles(directory="./stream/"), name="stream")

@app.get("/{full_path:path}")
async def spa(full_path: str):
    if full_path is "stream":
        return FileResponse("stream/index.html")
    return FileResponse("site/index.html")