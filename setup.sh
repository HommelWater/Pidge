VENV_DIR="$(pwd)/venv"
cd "$(dirname "$0")"
python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install -q fastapi pyotp uvicorn[standard] python-multipart requests websockets
cd ./src
uvicorn main:app --host "::" --port 80 --reload