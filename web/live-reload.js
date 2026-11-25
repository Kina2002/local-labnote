// Loaded only when the desktop app is running beside editable source files.
(() => {
  const sessionToken = document.getElementById('app').dataset.token;
  let seenVersion = null;
  let checking = false;
  let reloading = false;

  async function checkForChanges() {
    if (checking || reloading) return;
    checking = true;
    try {
      const response = await fetch('/api/live-version', {
        headers: {'X-Labnote-Token': sessionToken}, cache: 'no-store'
      });
      if (!response.ok) return;
      const {version} = await response.json();
      if (seenVersion === null) { seenVersion = version; return; }
      if (version === seenVersion) return;
      const editing = document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
      if (editing || document.querySelector('dialog[open]')) return;
      reloading = true;
      try {
        if (typeof persistRecordEdits === 'function') await persistRecordEdits();
        window.location.reload();
      } catch (error) {
        reloading = false;
        if (typeof toast === 'function') toast(`변경 사항을 적용하기 전에 저장하지 못했습니다: ${error.message}`);
      }
    } catch (_) {
      // The app may be replacing its request handler; try again on the next poll.
    } finally {
      checking = false;
    }
  }

  checkForChanges();
  setInterval(checkForChanges, 1500);
  window.addEventListener('focus', checkForChanges);
})();
