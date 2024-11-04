const fs = require('fs');
const path = require('path');

const newVersion = process.argv[2];

if (!newVersion) {
    console.error('请提供新版本号，例如: node update-version.js 3.1.0');
    process.exit(1);
}

const files = [
    path.join(__dirname, 'server/package.json'),
    path.join(__dirname, 'web/package.json')
];

files.forEach(file => {
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    content.version = newVersion;
    fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n');
    console.log(`已更新 ${file} 的版本到 ${newVersion}`);
});