/**
 * Post-Run Telemetry & Cloud Persistence (Direct MongoDB Mode)
 * 
 * Used by GitHub Actions runners to parse bot run logs and write
 * updated points, run counters, and execution status directly to
 * MongoDB Atlas rewards_accounts and farming_accounts collections.
 */

const { MongoClient } = require('mongodb');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

// Helper for waiting
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to send Discord webhook embed natively
function sendDiscordEmbed(webhookUrl, payload) {
    return new Promise((resolve) => {
        try {
            const url = new URL(webhookUrl);
            const data = JSON.stringify(payload);
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                res.resume();
                resolve();
            });

            req.on('error', (e) => {
                console.warn('[log-run-mongo] Discord webhook request error:', e.message);
                resolve();
            });

            req.write(data);
            req.end();
        } catch (e) {
            console.warn('[log-run-mongo] Failed to format Discord webhook:', e.message);
            resolve();
        }
    });
}

// Escape special regex characters in email strings
function escapeRegex(str) {
    return String(str).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build anchored case-insensitive regular expression for exact email matching
function buildEmailRegex(email) {
    return new RegExp(`^${escapeRegex(email)}$`, 'i');
}

/**
 * Smart Multi-Cluster Auto-Routing Resolver
 * Determines target MongoDB URI based on Group ID range:
 * - Groups 001 - 100 -> Cluster 1 (MONGODB_URI_1)
 * - Groups 101 - 200 -> Cluster 2 (MONGODB_URI_2)
 * - Groups 201 - 300 -> Cluster 3 (MONGODB_URI_3)
 * Falls back to generic MONGODB_URI if numbered secret is unset.
 */
function resolveMongoUri(groupId, type = 'data') {
    const rawNumber = String(groupId || '001').replace(/\D/g, '');
    const groupNum = parseInt(rawNumber, 10) || 1;
    const prefix = type === 'session' ? 'SESSION_MONGODB_URI' : 'MONGODB_URI';

    // 100 groups per cluster (600 accounts)
    const clusterIndex = Math.floor((groupNum - 1) / 100) + 1;
    const clusterKey = `${prefix}_${clusterIndex}`;

    // 1. Check for specific numbered cluster secret (e.g. MONGODB_URI_1)
    if (process.env[clusterKey] && process.env[clusterKey] !== 'null') {
        return { uri: process.env[clusterKey], clusterIndex, source: clusterKey };
    }

    // 2. Check for general fallback secret (e.g. MONGODB_URI)
    if (process.env[prefix] && process.env[prefix] !== 'null') {
        return { uri: process.env[prefix], clusterIndex, source: prefix };
    }

    // 3. For session type, fallback to data URI if session URI is absent
    if (type === 'session') {
        return resolveMongoUri(groupId, 'data');
    }

    return null;
}

async function main() {
    const rawSlot = process.argv[2] || '1';
    const groupId = process.env.GROUP_ID || '001';
    const dataCluster = resolveMongoUri(groupId, 'data');
    const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || null;

    if (!dataCluster || !dataCluster.uri) {
        console.log('[log-run-mongo] Neither MONGODB_URI nor MONGODB_URI_<N> provided. Skipping direct cloud persistence.');
        return;
    }

    const mongoUri = dataCluster.uri;

    // 1. Identify Target Account from .env
    let accountEmail = null;
    if (fs.existsSync('.env')) {
        const envContent = fs.readFileSync('.env', 'utf8');
        const match = envContent.match(/^ACCOUNT_1_EMAIL=(.+)$/m);
        if (match && match[1] && match[1].trim() !== '') {
            accountEmail = match[1].trim();
        }
    }

    if (!accountEmail) {
        console.log('[log-run-mongo] No ACCOUNT_1_EMAIL found in .env (slot may be empty or unassigned). Exiting.');
        return;
    }

    // 2. Read and Parse Container Logs
    const logPath = path.resolve(process.cwd(), 'container.log');
    let logContent = '';
    if (fs.existsSync(logPath)) {
        logContent = fs.readFileSync(logPath, 'utf8');
    }

    let exitCode = 0;
    if (fs.existsSync('container.exitcode')) {
        const rawCode = fs.readFileSync('container.exitcode', 'utf8').trim();
        exitCode = parseInt(rawCode, 10) || 0;
    }

    // Check for Run-End summary line
    // e.g.: Completed all accounts | accountsProcessed=1 | pointsGained=250 | previousBalance=12000 | currentBalance=12250 | runtimeMinutes=12.4
    const summaryMatch = logContent.match(/Completed all accounts \|.*pointsGained=(\d+).*previousBalance=(\d+).*currentBalance=(\d+).*runtimeMinutes=([\d.]+)/i);

    let pointsGained = null;
    let previousBalance = null;
    let currentBalance = null;
    let runtimeMinutes = null;
    let status = 'Finished';

    if (summaryMatch) {
        pointsGained = parseInt(summaryMatch[1], 10);
        previousBalance = parseInt(summaryMatch[2], 10);
        currentBalance = parseInt(summaryMatch[3], 10);
        runtimeMinutes = parseFloat(summaryMatch[4]);
        status = 'Finished';
    } else {
        // Evaluate failure signatures
        if (/suspended/i.test(logContent)) {
            status = 'Suspended';
        } else if (/locked/i.test(logContent)) {
            status = 'Locked';
        } else if (/2FA|two-factor|authenticator/i.test(logContent)) {
            status = '2FA Required';
        } else if (/password|credentials/i.test(logContent) && exitCode !== 0) {
            status = 'Bad Password';
        } else if (/proxy/i.test(logContent) && exitCode !== 0) {
            status = 'Proxy Error';
        } else if (exitCode !== 0) {
            status = 'Failed';
        } else {
            status = 'Incomplete';
        }
    }

    console.log('=====================================================');
    console.log('  Dual-Mode Post-Run Telemetry');
    console.log(`  Account Email     : ${accountEmail}`);
    console.log(`  Cluster Partition : Cluster ${dataCluster.clusterIndex} (via ${dataCluster.source})`);
    console.log(`  Execution Status  : ${status}`);
    if (currentBalance !== null) {
        console.log(`  Points Gained     : +${pointsGained}`);
        console.log(`  Current Balance   : ${currentBalance}`);
        console.log(`  Runtime           : ${runtimeMinutes} minutes`);
    }
    console.log('=====================================================');

    // 3. Connect to MongoDB Atlas and Persist Run State (With Resilient 3-Attempt Retry)
    const maxAttempts = 3;
    let client = null;
    let persistSuccess = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            console.log(`[log-run-mongo] Connecting to MongoDB Atlas (Attempt ${attempt}/${maxAttempts})...`);
            client = new MongoClient(mongoUri, {
                serverSelectionTimeoutMS: 8000,
                connectTimeoutMS: 8000
            });

            await client.connect();

            let dbName = 'test';
            try {
                const urlParsed = new URL(mongoUri.replace(/^mongodb\+srv:\/\//, 'http://'));
                if (urlParsed.pathname && urlParsed.pathname.length > 1) {
                    dbName = urlParsed.pathname.substring(1).split('?')[0];
                }
            } catch (_) {}

            const db = client.db(dbName);

            // Update rewards_accounts collection (matches MSR-Database core dashboard)
            const updateFields = {
                status: status,
                last_updated_at: new Date().toISOString()
            };

            if (currentBalance !== null) {
                updateFields.total_points = currentBalance;
                updateFields.logs = `Points: +${pointsGained} | Balance: ${currentBalance} | Time: ${runtimeMinutes}m`;
            } else {
                updateFields.logs = `Execution finished with status: ${status} (Exit Code: ${exitCode})`;
            }

            const rewardsUpdateOp = {
                $set: updateFields
            };

            // Increment run_days and offline_run_days if run completed or earned points
            if (status === 'Finished' || (pointsGained !== null && pointsGained > 0)) {
                rewardsUpdateOp.$inc = { run_days: 1, offline_run_days: 1 };
            }

            // Resilient case-insensitive update for rewards_accounts (avoids duplicate casing records)
            const emailRegex = buildEmailRegex(accountEmail);
            const existingReward = await db.collection('rewards_accounts').findOne({ email: emailRegex });
            if (existingReward) {
                await db.collection('rewards_accounts').updateOne(
                    { _id: existingReward._id },
                    rewardsUpdateOp
                );
            } else {
                rewardsUpdateOp.$setOnInsert = { synced_offline_run_days: 0 };
                await db.collection('rewards_accounts').updateOne(
                    { email: accountEmail },
                    rewardsUpdateOp,
                    { upsert: true }
                );
            }
            console.log(`[log-run-mongo] ✅ Successfully updated rewards_accounts in MongoDB.`);

            // Also update farming_accounts collection
            const farmingUpdate = {
                last_status: status,
                last_run: new Date().toISOString()
            };
            if (currentBalance !== null) {
                farmingUpdate.total_points = currentBalance;
            }

            const existingFarming = await db.collection('farming_accounts').findOne({ email: emailRegex });
            if (existingFarming) {
                await db.collection('farming_accounts').updateOne(
                    { _id: existingFarming._id },
                    { $set: farmingUpdate }
                );
            } else {
                await db.collection('farming_accounts').updateOne(
                    { email: accountEmail },
                    { $set: farmingUpdate }
                );
            }
            console.log(`[log-run-mongo] ✅ Successfully updated farming_accounts in MongoDB.`);

            // Instant socket disconnect
            await client.close();
            client = null;
            persistSuccess = true;
            break;
        } catch (err) {
            console.warn(`[log-run-mongo] Warning: Attempt ${attempt} failed: ${err.message}`);
            if (client) {
                try { await client.close(); } catch (_) {}
                client = null;
            }

            if (attempt === maxAttempts) {
                console.error('[log-run-mongo] Failed to persist run state to MongoDB after exhausting all attempts.');
            } else {
                const backoffMs = attempt * 3000;
                console.log(`[log-run-mongo] Retrying in ${backoffMs / 1000}s...`);
                await sleep(backoffMs);
            }
        }
    }

    // 4. Send Fallback Discord Notification If Bot Exited Non-Zero
    if (discordWebhookUrl && status !== 'Finished') {
        const color = status === 'Suspended' || status === 'Locked' ? 0xff0000 : 0xffaa00;
        const embedPayload = {
            embeds: [
                {
                    title: `⚠️ Account Alert: ${accountEmail}`,
                    description: `Farming completed with status **${status}** (Slot ${rawSlot})`,
                    color: color,
                    fields: [
                        { name: 'Status', value: status, inline: true },
                        { name: 'Exit Code', value: String(exitCode), inline: true },
                        { name: 'Timestamp', value: new Date().toUTCString(), inline: false }
                    ],
                    footer: { text: 'MSR Dual-Mode Autonomous Runner' }
                }
            ]
        };

        await sendDiscordEmbed(discordWebhookUrl, embedPayload);
    }
}

main().catch((err) => {
    console.error('[log-run-mongo] Uncaught Exception:', err);
    process.exit(0); // Non-fatal so workflow doesn't fail on reporting
});
