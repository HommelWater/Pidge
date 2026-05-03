from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from routers.auth_router import router as auth_router
from routers.auth_router import CONTYPE, PEERS, ClientRequest, get_invite_code, get_user_and_session, user_is_invalid
from routers.file_router import router as file_router
from routers.user_router import router as user_router
from routers.persistent_router import router as persistent_router

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"{CONTYPE}{p}" for p in PEERS],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)

app.include_router(auth_router, prefix="/auth")
app.include_router(file_router, prefix="/files")
app.include_router(user_router, prefix="/users")
app.include_router(persistent_router, prefix="/persistent")

# Example request for getting user information.
@app.post("/server_data_example")
async def server_data_example(data: ClientRequest):
    user, session = get_user_and_session(data.session)
    msg = user_is_invalid(user)
    if msg: return msg
    invite_code = get_invite_code(user)
    if not invite_code:
        invite_code = {"type":"failure", "data":{"notification":"Error getting invite code."}}
    return {"user":user, "new_invite_code": invite_code}

app.mount("/interface/", StaticFiles(directory="./interface/"), name="interface")

@app.get("/{full_path:path}")
async def spa(full_path: str):
    if full_path == "auth":
        return FileResponse("interface/auth/index.html")
    if full_path == "users":
        return FileResponse("interface/users/index.html")
    return FileResponse("interface/main/index.html")