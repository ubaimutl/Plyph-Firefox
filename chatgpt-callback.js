
(async () => {
  const status = document.getElementById('status');
  const params = Object.fromEntries(new URLSearchParams(location.search));
  try {
    const response = await browser.runtime.sendMessage({type: 'CHATGPT_CALLBACK', query: params});
    if (!response?.ok) throw new Error(response?.error || 'No sign-in attempt is waiting.');
    status.textContent = 'Connected. This window will close automatically.';
  } catch (error) {
    status.textContent = `Could not complete sign-in: ${error?.message || error}`;
    status.classList.add('error');
  }
})();
