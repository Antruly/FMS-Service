// 简单测试 video-preview 接口
const http = require('http');

const options = {
    hostname: 'localhost',
    port: 88,
    path: '/api/files/video-preview?id=test',
    method: 'GET'
};

console.log('测试 video-preview 接口...\n');

const req = http.request(options, (res) => {
    console.log('状态码:', res.statusCode);
    console.log('Headers:', JSON.stringify(res.headers, null, 2));

    let data = [];
    res.on('data', (chunk) => {
        data.push(chunk);
    });

    res.on('end', () => {
        const total = Buffer.concat(data);
        console.log('数据大小:', total.length, '字节');
        if (total.length > 0) {
            console.log('前 100 字节:', total.slice(0, 100).toString('hex').substring(0, 200));
        }
    });
});

req.on('error', (e) => {
    console.error('请求错误:', e.message);
});

req.end();
