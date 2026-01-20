/**
 * TOTP Test Script
 * Run this to verify if the TOTP secret is generating correct codes
 * 
 * Usage: node test-totp.js YOUR_TOTP_SECRET
 */

const speakeasy = require('speakeasy');

// Get secret from command line
const secret = process.argv[2] || 'Z2WEEVRO'; // First 8 chars from logs

if (!secret) {
    console.log('Usage: node test-totp.js YOUR_TOTP_SECRET');
    process.exit(1);
}

// Sanitize secret
const sanitizedSecret = secret.replace(/\s+/g, '').toUpperCase();

console.log('='.repeat(50));
console.log('TOTP TEST');
console.log('='.repeat(50));
console.log(`Original secret: ${secret}`);
console.log(`Sanitized secret: ${sanitizedSecret}`);
console.log(`Secret length: ${sanitizedSecret.length}`);
console.log('');

// Current time info
const currentTimestamp = Math.floor(Date.now() / 1000);
const timeInPeriod = currentTimestamp % 30;
const totpStep = Math.floor(currentTimestamp / 30);

console.log(`Current UNIX timestamp: ${currentTimestamp}`);
console.log(`Current UTC time: ${new Date().toISOString()}`);
console.log(`TOTP time step: ${totpStep}`);
console.log(`Seconds into current period: ${timeInPeriod}`);
console.log(`Seconds until next period: ${30 - timeInPeriod}`);
console.log('');

// Generate codes
console.log('Generated TOTP codes:');
console.log('-'.repeat(50));

// Try different windows
for (let offset = -2; offset <= 2; offset++) {
    const code = speakeasy.totp({
        secret: sanitizedSecret,
        encoding: 'base32',
        time: Date.now() + (offset * 30 * 1000),
        step: 30
    });

    const label = offset === 0 ? 'CURRENT' : (offset < 0 ? `-${Math.abs(offset)}` : `+${offset}`);
    console.log(`  ${label.padEnd(8)}: ${code}`);
}

console.log('');
console.log('Instructions:');
console.log('1. Open your authenticator app (Google Authenticator, Authy, etc.)');
console.log('2. Compare the code shown in the app with CURRENT above');
console.log('3. If they match: Secret is correct!');
console.log('4. If they don\'t match: Check if secret is copied correctly');
console.log('');

// Generate codes every 5 seconds for 30 seconds
console.log('Live code updates (next 30 seconds):');
console.log('-'.repeat(50));

let count = 0;
const interval = setInterval(() => {
    const code = speakeasy.totp({
        secret: sanitizedSecret,
        encoding: 'base32',
        step: 30
    });
    const timeLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
    console.log(`  Code: ${code} (expires in ${timeLeft}s)`);

    count++;
    if (count >= 6) {
        clearInterval(interval);
        console.log('');
        console.log('Test complete!');
    }
}, 5000);
