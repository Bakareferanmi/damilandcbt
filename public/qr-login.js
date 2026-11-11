const decoderAsset = '/assets/qr-scanner.js';

export function mountQrLogin(form, signIn) {
  const button = document.createElement('button');
  button.className = 'ghost qr-open';
  button.type = 'button';
  button.textContent = 'Scan login slip';
  const dialog = document.createElement('dialog');
  dialog.className = 'qr-dialog';
  dialog.setAttribute('aria-label', 'Scan login slip');
  dialog.innerHTML = `
    <h2>Scan login slip</h2>
    <p>Hold the QR code on your slip up to the camera.</p>
    <video muted playsinline></video>
    <p role="status"></p>
    <button type="button" class="ghost">Close camera</button>
  `;
  form.after(button, dialog);

  const video = dialog.querySelector('video');
  const status = dialog.querySelector('[role="status"]');
  const close = dialog.querySelector('button');
  const canvas = document.createElement('canvas');
  let stream, frame, generation = 0, signingIn = false;

  function stopCamera() {
    generation++;
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    video.srcObject = null;
    video.hidden = true;
  }

  close.onclick = () => { stopCamera(); dialog.close(); };
  dialog.addEventListener('close', stopCamera);
  dialog.addEventListener('cancel', stopCamera);
  addEventListener('pagehide', stopCamera);

  button.onclick = async () => {
    if (signingIn) return;
    dialog.showModal();
    video.hidden = true;
    status.textContent = 'Opening camera…';
    const run = ++generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('Camera unavailable');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw Error('Camera unavailable');
      const { default: decode } = await import(decoderAsset);
      if (run !== generation) return;
      const camera = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, facingMode: 'user' }, audio: false });
      if (run !== generation) {
        camera.getTracks().forEach(track => track.stop());
        return;
      }
      stream = camera;
      video.srcObject = stream;
      await video.play();
      if (run !== generation) return;
      video.hidden = false;
      status.textContent = 'Looking for the QR code…';
      let lastScan = -Infinity;
      const scan = async (time) => {
        if (run !== generation) return;
        if (time - lastScan >= 125 && video.videoWidth && video.videoHeight && video.readyState >= 2) {
          lastScan = time;
          const scale = Math.min(1, 640 / video.videoWidth);
          const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          context.drawImage(video, 0, 0, width, height);
          const result = decode(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: 'dontInvert' });
          if (result?.data.startsWith('DC1.')) {
            stopCamera();
            signingIn = true;
            status.textContent = 'Signing in…';
            try {
              await signIn(result.data);
              if (dialog.open) dialog.close();
            } catch (error) {
              status.textContent = error.message;
            } finally {
              signingIn = false;
            }
            return;
          }
        }
        frame = requestAnimationFrame(scan);
      };
      frame = requestAnimationFrame(scan);
    } catch {
      if (run !== generation) return;
      stopCamera();
      status.textContent = 'The camera could not open. Allow camera access and try again, or use your student code and password.';
    }
  };
}
