const m = process.mainModule && process.mainModule.require ? process.mainModule.require('electron') : null;
const wins = m.BrowserWindow.getAllWindows();
const w = wins.find(x => x.webContents.getURL().indexOf('22077') !== -1) || wins[0];
const img = await w.webContents.capturePage();
const png = img.toPNG();
const fs = process.mainModule.require('fs');
const path = 'C:/Users/Asus/Documents/GitHub/.ThisCrowd/.codex-tmp/stop-after-fix.png';
fs.writeFileSync(path, png);
return 'saved ' + png.length + ' bytes';
