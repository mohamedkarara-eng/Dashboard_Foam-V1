const fs = require('fs');

const md = fs.readFileSync('Dashboard_Foam.md', 'utf-8');
const cut = md.indexOf('<script type="text/legacy">');
const base = cut !== -1 ? md.slice(0, cut) : md;
const clientJs = fs.readFileSync('dashboard_client.js', 'utf-8');

const finalHtml = base.trim() + '\n<script>\n' + clientJs.trim() + '\n</script>\n</body>\n</html>\n';
fs.writeFileSync('Dashboard_Foam.html', finalHtml, 'utf-8');
console.log('✅ Dashboard_Foam.html built successfully, size:', finalHtml.length);
