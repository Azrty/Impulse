const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ffmpeg = require('ffmpeg-static');

const appRoot = path.resolve(__dirname, '..');
const impulseRoot = path.resolve(appRoot, '..');
const sourceVideo = path.join(appRoot, 'assets', 'bg.mp4');
const sourceLogo = path.join(appRoot, 'assets', 'icon-mono.png');
const targets = ['forge-1.7.10', 'forge-1.12.2', 'forge-1.20.1', 'forge-1.21.1', 'neoforge-1.21.1'];
const frameRate = 24;
const durationSeconds = 30;
const maxFrames = frameRate * durationSeconds;
const pngTargets = new Set();

function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${args.join(' ')}`);
  }
}

function ensureSource(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing asset: ${file}`);
}

ensureSource(sourceVideo);
ensureSource(sourceLogo);

for (const target of targets) {
  const isPngTarget = pngTargets.has(target);
  const frameExt = isPngTarget ? 'png' : 'jpg';
  const frameSize = isPngTarget ? '640:360' : '960:540';
  const resourceRoot = path.join(impulseRoot, 'mod', target, 'src', 'main', 'resources', 'assets', 'impulse');
  const menuDir = path.join(resourceRoot, 'textures', 'gui', 'menu');
  fs.mkdirSync(menuDir, { recursive: true });

  for (const file of fs.readdirSync(menuDir)) {
    if (/^bg_\d+\.(jpg|png)$/i.test(file) || file === 'logo.png') {
      fs.rmSync(path.join(menuDir, file), { force: true });
    }
  }

  run([
    '-y',
    '-i', sourceVideo,
    '-vf', `fps=${frameRate},scale=${frameSize}:force_original_aspect_ratio=increase,crop=${frameSize}`,
    '-t', String(durationSeconds),
    '-frames:v', String(maxFrames),
    ...(isPngTarget ? ['-compression_level', '9', '-pred', 'mixed'] : ['-q:v', '7']),
    '-start_number', '0',
    path.join(menuDir, `bg_%03d.${frameExt}`)
  ]);

  run([
    '-y',
    '-i', sourceLogo,
    '-vf', 'scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
    '-frames:v', '1',
    '-update', '1',
    path.join(menuDir, 'logo.png')
  ]);

  const framePattern = new RegExp(`^bg_\\d+\\.${frameExt}$`, 'i');
  const frames = fs.readdirSync(menuDir).filter((file) => framePattern.test(file)).sort();
  if (frames.length === 0) throw new Error(`No frames generated for ${target}`);

  fs.writeFileSync(
    path.join(resourceRoot, 'menu.properties'),
    `frames=${frames.length}\nfps=${frameRate}\next=${frameExt}\n`,
    'utf8'
  );

  console.log(`Prepared ${target}: ${frames.length} frames`);
}
