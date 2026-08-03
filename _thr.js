const io = require('socket.io-client');
const s = io.connect('http://localhost:3000', {reconnection:true});
const token = 'thrtok2';
let msgs = 0, lastCount = 0, disc = 0;
const fs = require('fs');
function w(m){ fs.appendFileSync(__dirname + '/thr_out.txt', m+'\n'); }
s.on('connect', () => { w('connected'); s.emit('request', { token, website: 'books.toscrape.com' }); });
s.on('disconnect', () => { disc++; w('DISCONNECT #'+disc); });
s.on(token, e => {
  msgs++;
  if (typeof e.fileCount === 'number') lastCount = e.fileCount;
  if (e.progress === 'Converting') w('[converting] socket-msgs='+msgs+' files='+lastCount);
  if (e.progress === 'Completed') { w('COMPLETED pages='+e.pages+' assets='+e.assets+' total-msgs='+msgs+' disconnects='+disc); process.exit(0); }
  else if (e.error) { w('ERR '+e.progress); process.exit(1); }
});
setTimeout(() => { w('TIMEOUT files='+lastCount+' msgs='+msgs+' disc='+disc); process.exit(2); }, 600000);
