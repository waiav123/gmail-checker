// SMTP RCPT TO 验证测试
const net = require('net');

function checkEmailSMTP(email, mxHost = 'gmail-smtp-in.l.google.com') {
  return new Promise((resolve) => {
    const socket = net.createConnection(25, mxHost);
    let step = 0, output = '';
    
    socket.setTimeout(10000);
    socket.on('timeout', () => { socket.destroy(); resolve({ error: 'timeout' }); });
    socket.on('error', (e) => resolve({ error: e.message }));
    
    socket.on('data', (data) => {
      const line = data.toString();
      output += line;
      
      if (step === 0 && line.startsWith('220')) {
        step = 1;
        socket.write('EHLO check.local\r\n');
      } else if (step === 1 && line.includes('250')) {
        step = 2;
        socket.write(`MAIL FROM:<test@check.local>\r\n`);
      } else if (step === 2 && line.startsWith('250')) {
        step = 3;
        socket.write(`RCPT TO:<${email}>\r\n`);
      } else if (step === 3) {
        const code = parseInt(line.substring(0, 3));
        socket.write('QUIT\r\n');
        socket.destroy();
        resolve({ email, code, response: line.trim(), exists: code === 250 });
      }
    });
  });
}

async function main() {
  const tests = [
    'test@gmail.com',           // 肯定存在
    'admin@gmail.com',          // 肯定存在
    'dhjfkjshfk234hjkdhkh@gmail.com',  // 大概率不存在
    'xyzrandom99887766abc@gmail.com',   // 大概率不存在
  ];
  
  for (const email of tests) {
    console.log(`Testing: ${email}`);
    const result = await checkEmailSMTP(email);
    console.log(`  Result:`, JSON.stringify(result));
  }
}

main().catch(console.error);
