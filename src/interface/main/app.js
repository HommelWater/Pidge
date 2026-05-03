document.addEventListener('DOMContentLoaded', load);

async function load(){
    const sk = localStorage.getItem("session");
    document.getElementById("session_key").innerText = `Your session key: ${sk}`;
    if (sk === "" || sk === null){
        location.href = "/auth";
    }
    const json = await apiRequest("/server_data_example", "POST", JSON.stringify({"session":sk}));
    document.getElementById("server_data").innerText = JSON.stringify(json, null, 2);
    loadFiles();
}

async function handleUpload() {
    const fileInput = document.getElementById('fileInput');
    const isPublic = document.getElementById('isPublic').checked;
    
    if (!fileInput.files[0]) {
        showToast('Please select a file', 'failure');
        return;
    }

    const res = await uploadFile(fileInput.files[0], isPublic, (pct) => showToast(`Uploading: ${pct}%`, "info"));
    if (!res || res.type === "failure") return;
    showToast('Upload complete!', 'success');
    fileInput.value = '';
    loadFiles();
}

// Load and display file list
async function loadFiles() {
    const listEl = document.getElementById('fileList');
    const session = localStorage.getItem("session");
    const res = await apiRequest("/files/", "POST", JSON.stringify({session}));
    if (!res || res.type === "failure") return;
    const files = res.data.files;
    listEl.innerHTML = files.map(f => `
        <div class="file-item">
        <span>${f.filename} ${f.is_public ? '(public)' : '(private)'}</span>
        <button onclick="handleDownload(${f.id}, '${f.filename}')">Download</button>
        </div>
    `).join('');
}

// Handle file download
async function handleDownload(fileId, filename) {
    try {
        showToast(`Starting download: ${filename}`, 'info');
        await downloadFile(fileId, (pct) => {
            if (pct) showToast(`Downloading: ${Math.round(pct * 100)}%`, 'info', 1000);
        });
        showToast('Download complete!', 'success');
    } catch (err) {
        showToast('Download failed: ' + err.message, 'failure');
    }
}

// Example persistent connection usage, sending a message.
async function sendMessage(e){
    const message = document.getElementById("messageInput").value;
    send("message", {message});
}

// Example persistent connection usage, receiving data and processing it.
async function message(username, message){
    document.getElementById("messages").innerHTML += `<p>${username}: ${message}</p>`;
}
persistent(message);  // Required to make the function callable by the server.