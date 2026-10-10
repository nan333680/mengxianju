import puppeteer from 'puppeteer-core';
const CHROME='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--disable-gpu']});
const page=await browser.newPage();
await page.setViewport({width:400,height:400,deviceScaleFactor:2});
const html = '<body style="margin:0;display:flex;gap:10px;background:#fff">' +
  '<div id="a" style="width:360px;height:360px;background:#ffe9a8;border:6px solid #000;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif">' +
  '<div style="font-size:150px;line-height:1">\u{1F431}</div>' +
  '<div style="font-size:60px;font-weight:900;color:#000;letter-spacing:4px">\u7b11\u6b7b</div>' +
  '</div>' +
  '<div id="b" style="width:360px;height:360px;background:#dfe6e9;border:6px solid #000;display:flex;align-items:center;justify-content:center;font-family:sans-serif">' +
  '<div style="font-size:44px;font-weight:900;color:#2d3436;text-align:center;line-height:1.2">\u4f60\u8bf4\u4ec0\u4e48\uff1f<br>\u6211\u542c\u4e0d\u61c2</div>' +
  '</div>' +
  '</body>';
await page.setContent(html);
await new Promise(r=>setTimeout(r,600));
await (await page.$('#a')).screenshot({ path: 'C:/A-DSH-Tool/tmp/meme1.png' });
await (await page.$('#b')).screenshot({ path: 'C:/A-DSH-Tool/tmp/meme2.png' });
console.log('生成完成');
await browser.close();
