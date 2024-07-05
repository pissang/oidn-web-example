import { initUNetFromURL } from 'oidn-web';

const ctx = document.getElementById('denoised').getContext('2d');

function loadImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.src = url;
    image.onload = () => {
      resolve(image);
    };
  });
}

initUNetFromURL(
  './rt_ldr_alb_nrm.tza',
  undefined,
  {
    aux: true,
  }
).then((unet) => {
  Promise.all([
    loadImage('./noisy.png'),
    loadImage('./albedo.png'),
    loadImage('./normal.png'),
  ]).then(([colorImage, albedoImage, normImage]) => {

    const w = colorImage.width;
    const h = colorImage.height;
    ctx.canvas.width = w;
    ctx.canvas.height = h;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(albedoImage, 0, 0, w, h);
    const albedoData = ctx.getImageData(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(normImage, 0, 0, w, h);
    const normData = ctx.getImageData(0, 0, w, h);

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(colorImage, 0, 0, w, h);
    const colorData = ctx.getImageData(0, 0, w, h);

    let time = Date.now();
    unet.tileExecute({
      color: colorData,
      albedo: albedoData,
      normal: normData,
      done() {
        const dTime = Date.now() - time;
        document.getElementById('status').innerHTML = 'Denoised. Takes ' + dTime + 'ms';
      },
      progress(_, tileData, tile) {
        ctx.putImageData(tileData, tile.x, tile.y);
      },
    });
  });
});
