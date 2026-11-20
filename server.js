const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? ' PASS ' : ' FAIL ') + m); };
const PORT = 19000 + Math.floor(Math.random() * 500), BASE = 'http://127.0.0.1:' + PORT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebui-'));
const SHOTS = '/home/claude/work/shots'; fs.mkdirSync(SHOTS, { recursive: true });

// a stand-in "game site" on localhost, to test embedding mechanics offline
const gameSite = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html><body style="background:#123;color:#fff"><h1 id="g">MOCK GAME LOADED</h1><canvas id="c" width="200" height="100"></canvas></body></html>'); });
let GS; const staticSrv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync('index_new.html')); });

(async () => {
  await new Promise(r => gameSite.listen(0, '127.0.0.1', r)); GS = 'http://127.0.0.1:' + gameSite.address().port + '/';
  await new Promise(r => staticSrv.listen(19999, '127.0.0.1', r));
  const child = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATA_DIR: dataDir, ALLOW_PRIVATE: '1' } });
  await new Promise((res, rej) => { child.stdout.on('data', d => String(d).includes('running') && res()); setTimeout(() => rej(new Error('no start')), 8000); });
  const browser = await chromium.launch();
  const errors = [];
  const watch = p => { p.on('pageerror', e => errors.push(String(e))); };

  // ================= admin browser =================
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const page = await ctx.newPage(); watch(page);
  const popups = []; ctx.on('page', p => { if (p !== page) popups.push(p); });
  await ctx.route('https://www.xbox.com/**', r => r.fulfill({ contentType: 'text/html', body: '<h1>mock xbox</h1>' }));
  await ctx.route('https://bloxd.io/**', r => r.fulfill({ contentType: 'text/html', body: '<html><body><h1 id="g">MOCK BLOXD DIRECT</h1></body></html>' }));
  let probeStub = null;
  await ctx.route('**/__nb/games/probe', r => probeStub ? r.fulfill({ contentType: 'application/json', body: JSON.stringify({ games: probeStub }) }) : r.continue());
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? (page._promptAnswer || d.defaultValue()) : undefined));

  console.log('\n[A] existing UI preserved');
  await page.goto(BASE + '/'); await page.waitForSelector('#clock');
  ok(await page.locator('#sc .sc').count() === 7, 'home shortcuts intact (YouTube, Discord, Instagram, TikTok, Spotify, Twitch + Add)');
  const tt = await page.locator('#sc .sc', { hasText: 'TikTok' }).count(); ok(tt === 1, 'TikTok shortcut still present');
  const order = await page.$$eval('#dock .ib, #dock .moon', els => els.map(e => e.id)); ok(order.join() === 'nHome,nGames,nHist,nSet,nAdmin,nHelp,nDisc,nMoon', 'dock order: ... Settings, Admin, Help ... -> ' + order.join());
  await page.waitForFunction(() => document.querySelector('#conn').textContent.includes('connected'));
  ok(true, 'server auto-connected (Server connected pill)');
  await page.screenshot({ path: SHOTS + '/01-home.png' });
  // TikTok shortcut routes through the proxy exactly as before
  await page.click('#sc .sc:has-text("TikTok")'); await page.waitForSelector('#browse.on');
  const tsrc = await page.$eval('#frames iframe.on', f => f.getAttribute('src')); ok(/^\/p\?u=https%3A%2F%2Fwww\.tiktok\.com/.test(tsrc), 'TikTok opens via /p?u= proxy: ' + tsrc);
  await page.click('#bHome');
  // search box
  await page.fill('#q', 'example.com'); await page.press('#q', 'Enter'); await page.waitForSelector('#browse.on');
  ok(/example\.com/.test(await page.$eval('#url', e => e.value)), 'address bar search/URL navigation still works');
  await page.click('#bHome');
  await page.click('#nSet'); await page.waitForSelector('#panel.on');
  const setTxt = await page.innerText('#panel'); ok(['Server', 'Look', 'Browsing', 'Data', 'Search engine', 'Basic-mode relay'].every(s => setTxt.includes(s)), 'Settings panel keeps all its sections');
  ok(!(await page.isVisible('#mirSec')), 'Mirror links section hidden while there are no mirrors');
  await page.click('#nHelp'); await page.waitForSelector('#panel.on'); ok((await page.innerText('#panel')).includes('Paste a page'), 'Help panel intact'); await page.keyboard.press('Escape');
  await page.click('#nHist'); ok((await page.innerText('#panel')).includes('History'), 'History panel intact'); await page.keyboard.press('Escape');

  console.log('\n[B] game library');
  await page.click('#nGames'); await page.waitForSelector('#lib.on');
  ok(await page.locator('.gc').count() === 18, '18 games listed (13 requested + 5 original classics)');
  const names = await page.$$eval('.gc', els => els.map(e => e.getAttribute('aria-label').replace('Play ', '')));
  const want = ['Fortnite', 'Roblox', 'Bloxd.io', 'Smash Karts', 'RocketGoal.io', 'PolyTrack', 'LOLBeans.io', 'Basketball Stars', 'Slow Roads', 'Miniblox', 'Soccer Bros', 'Gartic Phone', 'TETR.IO'];
  ok(want.every(n => names.includes(n)), 'all 13 requested games present');
  ok(['Chess', '2048', 'Wordle', 'Slither.io', 'Agar.io'].every(n => names.includes(n)), 'previous Games-panel entries kept');
  ok(await page.locator('.gc svg.art').count() === 18, 'every game has a thumbnail');
  await page.screenshot({ path: SHOTS + '/02-library.png' });
  await page.fill('#libQ', 'tet'); ok(await page.locator('.gc').count() === 1 && (await page.innerText('.gc')).includes('Racing') === false, 'search "tet" -> TETR.IO only');
  await page.fill('#libQ', 'soccer'); ok(await page.locator('.gc').count() === 2, 'search matches tags too ("soccer" -> RocketGoal.io + Soccer Bros)');
  await page.fill('#libQ', 'zzzz'); ok((await page.innerText('#libCards')).includes('No games match'), 'empty search shows a message');
  await page.fill('#libQ', '');
  await page.click('#libCats [data-c="Racing"]'); ok(await page.locator('.gc').count() === 3, 'Racing category: Smash Karts, PolyTrack, Slow Roads');
  await page.click('#libCats [data-c="Sports"]'); ok(await page.locator('.gc').count() === 3, 'Sports category: RocketGoal, Basketball Stars, Soccer Bros');
  await page.click('#libCats [data-c="Favorites"]'); ok((await page.innerText('#libCards')).includes('No favorites yet'), 'Favorites starts empty');
  await page.click('#libCats [data-c="All"]');
  await page.click('.gc[data-id="roblox"] .fav'); await page.click('.gc[data-id="tetrio"] .fav');
  ok((await page.innerText('#libCats')).includes('Favorites (2)'), 'hearting two games -> Favorites (2)');
  await page.click('#libCats [data-c="Favorites"]'); ok(await page.locator('.gc').count() === 2, 'Favorites filter shows the two');
  await page.reload(); await page.waitForSelector('#clock'); await page.click('#nGames'); await page.click('#libCats [data-c="Favorites"]');
  ok(await page.locator('.gc').count() === 2, 'favorites persist after reload');
  await page.click('.gc[data-id="tetrio"] .fav'); ok(await page.locator('.gc').count() === 1, 'un-heart removes it');
  await page.click('#libCats [data-c="All"]');

  console.log('\n[C] launching games');
  // external: Fortnite
  popups.length = 0; await page.click('.gc[data-id="fortnite"]'); await page.waitForTimeout(600);
  ok(popups.length === 1 && popups[0].url().startsWith('https://www.xbox.com/play'), 'Fortnite opens Xbox Cloud Gaming in a new tab: ' + (popups[0] && popups[0].url()));
  ok((await page.innerText('#toast')).includes('Xbox Cloud Gaming'), 'toast explains why it opens externally');
  await popups[0].close();
  // classic: Chess opens in a Nebula browser tab through the proxy, same as before
  await page.click('.gc[data-id="chess"]'); await page.waitForSelector('#browse.on'); ok(!(await page.isVisible('#lib')), 'classic game closes the library and opens a browser tab');
  const csrc = await page.$eval('#frames iframe.on', f => f.getAttribute('src')); ok(/chess\.com/.test(decodeURIComponent(csrc)) && csrc.startsWith('/p?u='), 'Chess routed through proxy: ' + csrc.slice(0, 60));
  await page.click('#bHome'); await page.click('#nGames'); await page.waitForSelector('#lib.on');
  // embedded, direct
  probeStub = { bloxd: { state: 'ok', http: 200 }, smashkarts: { state: 'noframe', http: 200, note: 'X-Frame-Options: DENY' } };
  await page.evaluate(() => { gProbeAt = 0; }); await page.evaluate(() => loadProbe()); await page.waitForTimeout(400);
  ok((await page.innerText('.gc[data-id="bloxd"] .gi')).includes('Plays here'), 'badge: embeddable game shows "Plays here"');
  ok((await page.innerText('.gc[data-id="fortnite"] .gi')).includes('New tab'), 'badge: Fortnite shows "New tab"');
  await page.click('.gc[data-id="bloxd"]'); await page.waitForSelector('#libPlay.on');
  const fr = page.frameLocator('#libWrap iframe'); await fr.locator('#g').waitFor({ timeout: 5000 });
  ok((await fr.locator('#g').innerText()) === 'MOCK BLOXD DIRECT', 'DIRECT mode: game page renders inside the library player');
  ok(await page.$eval('#libWrap iframe', f => f.getAttribute('allow').includes('fullscreen') && f.hasAttribute('allowfullscreen')), 'game iframe allows fullscreen/gamepad');
  ok((await page.innerText('#libT')) === 'Bloxd.io' && await page.$eval('#sgDirect', e => e.classList.contains('on')), 'toolbar shows title + Direct selected');
  await page.screenshot({ path: SHOTS + '/03-player.png' });
  // switch to proxy using a localhost stand-in for the game URL
  await page.evaluate(u => { GAMES.find(g => g.id === 'bloxd').url = u; playing.g = GAMES.find(g => g.id === 'bloxd'); }, GS);
  await page.click('#sgProxy'); await page.waitForTimeout(300);
  const psrc = await page.$eval('#libWrap iframe', f => f.getAttribute('src')); ok(psrc.startsWith('/p?u=') && decodeURIComponent(psrc).includes(GS.replace(/\/$/, '')), 'PROXY mode: iframe points at /p?u=<game>');
  await fr.locator('#g').waitFor({ timeout: 8000 }); ok((await fr.locator('#g').innerText()) === 'MOCK GAME LOADED', 'PROXY mode: game page actually renders through the Nebula proxy');
  await page.click('#sgDirect'); await page.waitForTimeout(300); ok((await page.$eval('#libWrap iframe', f => f.getAttribute('src'))) === GS, 'switching back to Direct reloads the game directly');
  // fullscreen
  await page.click('#libFs'); await page.waitForTimeout(400);
  const isFs = await page.evaluate(() => !!document.fullscreenElement || document.getElementById('libWrap').classList.contains('pfs')); ok(isFs, 'Fullscreen button puts the game area into fullscreen');
  await page.screenshot({ path: SHOTS + '/04-fullscreen.png' });
  await page.click('#libFs').catch(async () => { await page.keyboard.press('Escape'); }); await page.waitForTimeout(300);
  await page.evaluate(() => { if (document.fullscreenElement) document.exitFullscreen(); document.getElementById('libWrap').classList.remove('pfs'); });
  // in-player favorite, new tab, reload, back
  await page.click('#libFav'); ok(await page.$eval('#libFav', e => e.classList.contains('fv')), 'favorite from inside the player');
  popups.length = 0; await page.click('#libTab'); await page.waitForTimeout(500); ok(popups.length === 1, 'player "Open in new tab" works'); await popups[0].close();
  await page.click('#libRel'); await page.waitForTimeout(300); ok(await page.locator('#libWrap iframe').count() === 1, 'reload keeps a single game frame');
  await page.click('#libBack'); ok(await page.isVisible('#libGrid') && (await page.locator('#libWrap iframe').count()) === 0, 'Back returns to the grid and unloads the game (stops audio)');
  // game that blocks embedding -> proxy automatically
  ok((await page.innerText('.gc[data-id="smashkarts"] .gi')).includes('Plays here'), 'blocked-embedding game still "Plays here" (via proxy when server connected)');
  await page.evaluate(u => { GAMES.find(g => g.id === 'smashkarts').url = u; }, GS);
  await page.click('.gc[data-id="smashkarts"]'); await page.waitForSelector('#libPlay.on');
  ok(await page.$eval('#sgProxy', e => e.classList.contains('on')) && (await page.$eval('#libWrap iframe', f => f.getAttribute('src'))).startsWith('/p?u='), 'probe says "noframe" -> player auto-selects Proxy');
  await fr.locator('#g').waitFor({ timeout: 8000 }); ok(true, 'auto-proxied game rendered');
  await page.keyboard.press('Escape'); ok(await page.isVisible('#libGrid'), 'Esc leaves the player');
  await page.click('#nHome'); ok(!(await page.isVisible('#lib')), 'Home button closes the library');

  console.log('\n[D] admin panel');
  await page.click('#nAdmin'); await page.waitForSelector('#adC'); ok(true, 'Admin button opens the code prompt');
  await page.screenshot({ path: SHOTS + '/05-admin-login.png' });
  await page.fill('#adC', 'letmein'); await page.click('#adGo'); await page.waitForFunction(() => document.querySelector('#adS').textContent.length > 0);
  ok((await page.innerText('#adS')).includes('Wrong admin code'), 'wrong code shows an error from the server');
  await page.fill('#adC', 'admin56721'); await page.click('#adGo'); await page.waitForSelector('.atabs');
  ok((await page.innerText('#panel')).includes('Users'), 'right code unlocks the panel');
  await page.fill('#adLabel', 'Jake'); await page.click('[data-a="create"]'); await page.waitForSelector('.urow:has-text("Jake")');
  const jakeCode = await page.$eval('.urow:has-text("Jake") .mono', e => e.textContent); ok(/^NEB-/.test(jakeCode), 'created individual code for Jake: ' + jakeCode);
  await page.screenshot({ path: SHOTS + '/06-admin-users.png' });
  await page.click('.urow:has-text("Jake") [data-a="block"]'); await page.waitForSelector('.urow.bl:has-text("Jake")'); ok(true, 'Block marks the user as Blocked');
  await page.click('.urow:has-text("Jake") [data-a="unblock"]'); await page.waitForSelector('.urow:has-text("Jake"):not(.bl)'); ok(true, 'Unblock restores');
  await page.fill('#adFilter', 'jak'); ok(await page.locator('#adList .urow').count() === 1, 'user filter works'); await page.fill('#adFilter', '');
  // mirrors
  await page.click('.atabs [data-v="mirrors"]'); await page.fill('#mName', 'Backup 1'); await page.fill('#mUrl', 'backup-one.example.com'); await page.click('[data-a="mAdd"]');
  await page.waitForSelector('.urow:has-text("Backup 1")'); ok((await page.innerText('.urow:has-text("Backup 1") .mono')) === 'https://backup-one.example.com/', 'mirror added and normalised');
  await page.fill('#mUrl', 'javascript:alert(1)'); await page.fill('#mName', 'Evil'); await page.click('[data-a="mAdd"]'); await page.waitForTimeout(300);
  ok(!(await page.innerText('#panel')).includes('Evil') && (await page.innerText('#toast')).includes('valid web address'), 'bad mirror address rejected with a message');
  page._promptAnswer = 'Renamed Mirror'; let n = 0; page.removeAllListeners('dialog'); page.on('dialog', d => d.accept(d.type() === 'prompt' ? (n++ === 0 ? 'Renamed Mirror' : 'https://renamed.example.net') : undefined));
  await page.click('.urow:has-text("Backup 1") [data-a="mEdit"]'); await page.waitForSelector('.urow:has-text("Renamed Mirror")'); ok(true, 'edit mirror (name + address)');
  await page.screenshot({ path: SHOTS + '/07-admin-mirrors.png' });
  await page.click('.atabs [data-v="games"]'); await page.click('[data-a="check"]'); await page.waitForSelector('#gcR .urow', { timeout: 60000 });
  ok(await page.locator('#gcR .urow').count() === 11, 'Games tab runs the server embed check and lists all 11 embeddable games (offline here, so they report Unreachable)');
  await page.click('.atabs [data-v="access"]'); ok((await page.innerText('#panel')).includes('Require an access code'), 'Access tab present');
  await page.click('[data-a="out"]'); await page.waitForTimeout(300); await page.click('#nAdmin'); await page.waitForSelector('#adC'); ok(true, 'after Sign out the code is required again');
  await page.fill('#adC', 'admin56721'); await page.click('#adGo'); await page.waitForSelector('.atabs');
  await page.keyboard.press('Escape');
  await page.click('#nSet'); await page.waitForSelector('#mirSec', { state: 'visible', timeout: 5000 }); ok((await page.innerText('#mirrorList')).includes('Renamed Mirror'), 'visitors see the enabled mirror in Settings');
  await page.keyboard.press('Escape');

  console.log('\n[E] blocking, end to end, with a second browser');
  const vctx = await browser.newContext(); const vp = await vctx.newPage(); watch(vp);
  await vp.goto(BASE + '/'); await vp.waitForSelector('#clock');
  const vcode = await vp.evaluate(async () => (await (await fetch('/__nb/me')).json()).code); ok(/^NEB-/.test(vcode), 'second visitor got their own automatic code: ' + vcode);
  await page.click('#nAdmin'); await page.waitForSelector('.atabs'); await page.fill('#adFilter', vcode);
  await page.click(`.urow:has-text("${vcode}") [data-a="block"]`); await page.waitForSelector(`.urow.bl:has-text("${vcode}")`);
  await vp.reload(); await vp.waitForTimeout(500); ok((await vp.innerText('body')).includes('Access blocked'), 'blocked visitor reloads and sees "Access blocked"');
  await vp.screenshot({ path: SHOTS + '/08-blocked.png' });
  const pr = await vp.evaluate(async () => (await fetch('/p?u=' + encodeURIComponent('https://example.com'))).status); ok(pr === 403, 'blocked visitor\u2019s proxy request returns 403');
  await page.click(`.urow:has-text("${vcode}") [data-a="unblock"]`); await page.waitForSelector(`.urow:has-text("${vcode}"):not(.bl)`);
  await vp.reload(); await vp.waitForSelector('#clock'); ok(true, 'unblocked visitor is back in');
  // require-code gate
  await page.click('.atabs [data-v="access"]'); await page.click('[data-a="req"]'); await page.waitForFunction(() => document.querySelector('[data-a="req"]').textContent === 'On');
  const gctx = await browser.newContext(); const gp = await gctx.newPage(); watch(gp);
  await gp.goto(BASE + '/'); ok((await gp.innerText('body')).includes('Enter your access code'), 'with codes required, a stranger sees the access-code page');
  await gp.screenshot({ path: SHOTS + '/09-gate.png' });
  await gp.fill('#k', 'NEB-NOPE-NOPE'); await gp.click('#go'); await gp.waitForFunction(() => document.getElementById('e').textContent.length > 0); ok((await gp.innerText('#e')).includes('valid'), 'wrong code is refused');
  await gp.fill('#k', jakeCode); await gp.click('#go'); await gp.waitForSelector('#clock', { timeout: 8000 }); ok(true, 'Jake enters his code and gets the real site');
  await page.click('[data-a="req"]'); await page.waitForFunction(() => document.querySelector('[data-a="req"]').textContent === 'Off');

  console.log('\n[F] basic mode (page hosted without the server)');
  const bctx = await browser.newContext(); const bp = await bctx.newPage(); watch(bp);
  await bp.goto('http://127.0.0.1:19999/'); await bp.waitForSelector('#clock'); await bp.waitForTimeout(1500);
  ok((await bp.innerText('#conn')).includes('Connect server'), 'static copy runs in basic mode (no server)');
  await bp.click('#nGames'); ok(await bp.locator('.gc').count() === 18, 'library still lists all games without a server');
  await bp.click('#nAdmin'); await bp.waitForTimeout(200); ok((await bp.innerText('#toast')).includes('Connect your server'), 'Admin explains it needs the server');
  await bp.click('#nSet'); await bp.waitForTimeout(300); ok(!(await bp.isVisible('#mirSec')), 'no mirror section in basic mode');
  await bp.click('#nGames'); await bp.click('#nGames'); await bp.click('.gc[data-id="smashkarts"]');
  await bp.waitForTimeout(300); ok(true, 'launching in basic mode does not throw');

  // mobile
  const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true }); const mp = await mctx.newPage(); watch(mp);
  await mp.goto(BASE + '/'); await mp.waitForSelector('#clock'); await mp.click('#nGames'); await mp.waitForSelector('#lib.on'); await mp.screenshot({ path: SHOTS + '/10-mobile.png' });
  const overflow = await mp.evaluate(() => document.getElementById('libGrid').scrollWidth - document.getElementById('libGrid').clientWidth); ok(overflow <= 1, 'mobile layout: no sideways overflow');

  console.log('\n[G] errors');
  const real = errors.filter(e => !/Failed to fetch|NetworkError|net::/.test(e)); ok(real.length === 0, 'no uncaught page errors' + (real.length ? ': ' + real.join(' | ').slice(0, 300) : ''));

  await browser.close(); child.kill('SIGTERM'); gameSite.close(); staticSrv.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
