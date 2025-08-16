// server.js - Fixed version with proper TON Connect support

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://ioioning.github.io/spingame/';
const TON_API_KEY = process.env.TON_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID || '@openingcases';
const PORT = process.env.PORT || 3000;
const REAL_TON_WALLET = process.env.TON_WALLET_ADDRESS || 'UQDx5LBGp7K7A5hrYu4y6W5RPO4hwk5fL_LWzov0FlYeJMMp';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve TON Connect manifest
app.get('/tonconnect-manifest.json', (req, res) => {
    const manifest = {
        url: WEBAPP_URL,
        name: "GrandSpin Bot",
        iconUrl: `${WEBAPP_URL}icon.png`,
        termsOfUseUrl: `${WEBAPP_URL}terms`,
        privacyPolicyUrl: `${WEBAPP_URL}privacy`
    };
    res.json(manifest);
});

// Generate unique wallet address for user
function generateWalletAddress(userId) {
    const hash = crypto.createHash('sha256').update(userId + 'grandspin_salt').digest('hex');
    return 'UQ' + hash.substring(0, 46);
}

// Database initialization
const db = new sqlite3.Database('bot.db');

// Create tables
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        telegram_id TEXT UNIQUE,
        username TEXT,
        first_name TEXT,
        balance REAL DEFAULT 0,
        referral_count INTEGER DEFAULT 0,
        channel_subscribed BOOLEAN DEFAULT 0,
        cases_opened INTEGER DEFAULT 0,
        total_deposited REAL DEFAULT 0,
        wallet_address TEXT,
        trial_used BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Transactions table
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        type TEXT,
        amount REAL,
        tx_hash TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Referrals table
    db.run(`CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id TEXT,
        referred_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Inventory table
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        item_name TEXT,
        item_value REAL,
        case_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Task completions table
    db.run(`CREATE TABLE IF NOT EXISTS task_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        task_id TEXT,
        completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, task_id)
    )`);

    // Pending deposits table
    db.run(`CREATE TABLE IF NOT EXISTS pending_deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        amount REAL,
        wallet_address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

async function checkTonTransaction(userId, minAmount = 0.01) {
    try {
        const response = await axios.get(`https://tonapi.io/v2/accounts/${REAL_TON_WALLET}/transactions`, {
            headers: { 'Authorization': `Bearer ${TON_API_KEY}` },
            params: { limit: 10 }
        });

        const transactions = response.data.transactions;
        const oneHourAgo = Date.now() - 3600000;

        for (const tx of transactions) {
            if (tx.in_msg && tx.in_msg.value && tx.in_msg.comment) {
                const amount = parseInt(tx.in_msg.value) / 1e9;
                const txTime = tx.utime * 1000;
                const comment = tx.in_msg.comment.trim();

                if (comment === userId.toString() && amount >= minAmount && txTime > oneHourAgo) {
                    return {
                        hash: tx.hash,
                        amount,
                        time: txTime
                    };
                }
            }
        }

        return null;
    } catch (error) {
        console.error('TON check error:', error.message);
        return null;
    }
}

// Check if user is subscribed to channel
async function checkChannelSubscription(userId) {
    try {
        const member = await bot.getChatMember(CHANNEL_ID, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error('Error checking channel subscription:', error.message);
        return false;
    }
}

// Bot commands
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const username = msg.from.username || '';
    const firstName = msg.from.first_name || '';
    const referralCode = match[1] ? match[1].trim() : '';

    // Check if user exists
    db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], async (err, row) => {
        if (err) {
            console.error('Database error:', err);
            return;
        }

        if (!row) {
            // Create new user
            const walletAddress = generateWalletAddress(userId);
            
            db.run(`INSERT INTO users (telegram_id, username, first_name, wallet_address) 
                    VALUES (?, ?, ?, ?)`, 
                   [userId, username, firstName, walletAddress], 
                   async (err) => {
                if (err) {
                    console.error('Error creating user:', err);
                    return;
                }

                // Handle referral
                if (referralCode && referralCode !== userId) {
                    db.get('SELECT * FROM users WHERE telegram_id = ?', [referralCode], (err, referrer) => {
                        if (!err && referrer) {
                            // Add referral
                            db.run('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)', 
                                   [referralCode, userId]);
                            
                            // Update referrer's count and balance
                            db.run('UPDATE users SET referral_count = referral_count + 1, balance = balance + 0.1 WHERE telegram_id = ?', 
                                   [referralCode]);
                            
                            // Add transaction record
                            db.run('INSERT INTO transactions (user_id, type, amount, status) VALUES (?, ?, ?, ?)',
                                   [referralCode, 'referral_bonus', 0.1, 'confirmed']);
                            
                            bot.sendMessage(referralCode, '✅ You received 0.1 TON for inviting a friend!');
                        }
                    });
                }
            });
        }

        // Send welcome message with improved keyboard
        const keyboard = {
            inline_keyboard: [
                [{ text: '🎮 Open App', web_app: { url: WEBAPP_URL } }],
                [{ text: '💰 Connect Wallet', web_app: { url: `${WEBAPP_URL}?tab=profile` } }]
            ]
        };

        const welcomeText = 
            `🎲 Welcome to GrandSpin Bot!\n\n` +
            `🎁 Open cases and get cool NFT gifts!\n` +
            `🆓 Free trial case available\n` +
            `✅ Complete tasks and get bonuses\n` +
            `👥 Invite friends and earn TON\n\n` +
            `Tap "Open App" to start playing!`;

        bot.sendMessage(chatId, welcomeText, { reply_markup: keyboard });
    });
});

// Deposit command
bot.onText(/\/deposit/, (msg) => {
    const userId = msg.from.id.toString();
    const chatId = msg.chat.id;
    
    const walletAddress = REAL_TON_WALLET;
    const depositComment = userId;

    const depositInfo = 
        `💰 *Deposit TON*\n\n` +
        `📤 Send TON to this address:\n\`${walletAddress}\`\n\n` +
        `💬 Comment for payment:\n\`${depositComment}\`\n\n` +
        `⚠️ *Important:* The comment must be exactly:\n\`${depositComment}\`\n\n` +
        `✅ After sending, use /check_deposit to verify your payment.`;

    bot.sendMessage(chatId, depositInfo, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔍 Check Deposit', callback_data: 'check_deposit' }],
                [{ text: '🎮 Open App', web_app: { url: WEBAPP_URL } }]
            ]
        }
    });
});

// Check deposit command
bot.onText(/\/check_deposit/, async (msg) => {
    const userId = msg.from.id.toString();
    const chatId = msg.chat.id;

    bot.sendMessage(chatId, '🔍 Checking for recent transactions...');

    try {
        const transaction = await checkTonTransaction(userId, 0.01);
        
        if (transaction) {
            // Check if already processed
            db.get('SELECT * FROM transactions WHERE tx_hash = ?', [transaction.hash], (err, existingTx) => {
                if (err) {
                    bot.sendMessage(chatId, '❌ Database error occurred.');
                    return;
                }
                
                if (existingTx) {
                    bot.sendMessage(chatId, '⚠️ This transaction has already been processed.');
                    return;
                }
                
                // Update user balance
                db.run('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE telegram_id = ?', 
                       [transaction.amount, transaction.amount, userId], (err) => {
                    if (err) {
                        bot.sendMessage(chatId, '❌ Failed to update balance.');
                        return;
                    }
                    
                    // Record transaction
                    db.run('INSERT INTO transactions (user_id, type, amount, tx_hash, status) VALUES (?, ?, ?, ?, ?)',
                           [userId, 'deposit', transaction.amount, transaction.hash, 'confirmed']);
                    
                    bot.sendMessage(chatId, 
                        `✅ *Deposit Confirmed!*\n\n` +
                        `💰 Amount: ${transaction.amount} TON\n` +
                        `🔗 Transaction: \`${transaction.hash.slice(0, 16)}...\`\n\n` +
                        `Your balance has been updated!`, 
                        { parse_mode: 'Markdown' }
                    );
                });
            });
        } else {
            bot.sendMessage(chatId, 
                `❌ No recent transactions found.\n\n` +
                `Make sure you:\n` +
                `• Sent to the correct address\n` +
                `• Used the exact comment: \`${userId}\`\n` +
                `• Wait a few minutes after sending`, 
                { parse_mode: 'Markdown' }
            );
        }
    } catch (error) {
        console.error('Error checking deposit:', error);
        bot.sendMessage(chatId, '❌ Error checking transactions. Please try again later.');
    }
});

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id.toString();

    if (data === 'check_deposit') {
        // Trigger deposit check
        bot.sendMessage(message.chat.id, '🔍 Checking for recent transactions...');
        
        try {
            const transaction = await checkTonTransaction(userId, 0.01);
            
            if (transaction) {
                // Process transaction (same logic as above)
                db.get('SELECT * FROM transactions WHERE tx_hash = ?', [transaction.hash], (err, existingTx) => {
                    if (!err && !existingTx) {
                        db.run('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE telegram_id = ?', 
                               [transaction.amount, transaction.amount, userId], (err) => {
                            if (!err) {
                                db.run('INSERT INTO transactions (user_id, type, amount, tx_hash, status) VALUES (?, ?, ?, ?, ?)',
                                       [userId, 'deposit', transaction.amount, transaction.hash, 'confirmed']);
                                
                                bot.sendMessage(message.chat.id, 
                                    `✅ *Deposit Confirmed!*\n\n💰 Amount: ${transaction.amount} TON`, 
                                    { parse_mode: 'Markdown' }
                                );
                            }
                        });
                    }
                });
            } else {
                bot.sendMessage(message.chat.id, '❌ No recent transactions found.');
            }
        } catch (error) {
            bot.sendMessage(message.chat.id, '❌ Error checking transactions.');
        }
    }

    // Answer callback query to remove loading state
    bot.answerCallbackQuery(callbackQuery.id);
});

// API Endpoints

// Get user data
app.get('/api/user/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], (err, user) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            balance: user.balance,
            referralCount: user.referral_count,
            channelSubscribed: user.channel_subscribed,
            casesOpened: user.cases_opened,
            totalDeposited: user.total_deposited,
            walletAddress: user.wallet_address,
            trialUsed: user.trial_used
        });
    });
});

// Get user inventory
app.get('/api/inventory/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.all('SELECT * FROM inventory WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, items) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        res.json(items);
    });
});

// Check deposit (manual check)
app.post('/api/check-deposit', async (req, res) => {
    const { userId, amount = 0.01 } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }
    
    try {
        db.get('SELECT wallet_address FROM users WHERE telegram_id = ?', [userId], async (err, user) => {
            if (err || !user) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const transaction = await checkTonTransaction(userId, amount);
            
            if (transaction) {
                // Check if this transaction was already processed
                db.get('SELECT * FROM transactions WHERE tx_hash = ?', [transaction.hash], (err, existingTx) => {
                    if (err) {
                        return res.status(500).json({ error: 'Database error' });
                    }
                    
                    if (existingTx) {
                        return res.json({ success: false, message: 'Transaction already processed' });
                    }
                    
                    // Update user balance
                    db.run('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE telegram_id = ?', 
                           [transaction.amount, transaction.amount, userId], (err) => {
                        if (err) {
                            return res.status(500).json({ error: 'Failed to update balance' });
                        }
                        
                        // Record transaction
                        db.run('INSERT INTO transactions (user_id, type, amount, tx_hash, status) VALUES (?, ?, ?, ?, ?)',
                               [userId, 'deposit', transaction.amount, transaction.hash, 'confirmed']);
                        
                        res.json({ 
                            success: true, 
                            transaction: transaction.hash,
                            amount: transaction.amount
                        });
                    });
                });
            } else {
                res.json({ success: false, message: 'No recent transactions found' });
            }
        });
    } catch (error) {
        console.error('Error checking deposit:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create deposit request
app.post('/api/create-deposit', (req, res) => {
    const { userId, amount = 0.01 } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }
    
    db.get('SELECT wallet_address FROM users WHERE telegram_id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Create pending deposit record
        db.run('INSERT INTO pending_deposits (user_id, amount, wallet_address) VALUES (?, ?, ?)',
               [userId, amount, user.wallet_address], (err) => {
            if (err) {
                return res.status(500).json({ error: 'Failed to create deposit request' });
            }
            
            res.json({
                success: true,
                walletAddress: REAL_TON_WALLET,
                amount: amount,
                comment: userId
            });
        });
    });
});

// Open case
app.post('/api/open-case', (req, res) => {
    const { userId, caseName, casePrice = 0.1 } = req.body;
    
    if (!userId || !caseName) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], (err, user) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Check if it's a trial case
        const isTrialCase = caseName === 'Trial Box';
        
        // Check trial usage
        if (isTrialCase && user.trial_used) {
            return res.status(400).json({ error: 'Trial case already used' });
        }
        
        // Check balance for paid cases
        if (!isTrialCase && user.balance < casePrice) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // Generate random prize based on case
        const casePrizes = {
            'Trial Box': [
                { name: 'Lucky Token', value: 1, chance: 0.5 },
                { name: 'Silver Star', value: 2, chance: 0.3 },
                { name: 'Golden Gift', value: 5, chance: 0.15 },
                { name: 'Diamond Box', value: 10, chance: 0.05 }
            ],
            'Sweet Box': [
                { name: 'Sweet Candy', value: 10, chance: 0.4 },
                { name: 'Sugar Crystal', value: 15, chance: 0.3 },
                { name: 'Honey Drop', value: 25, chance: 0.2 },
                { name: 'Golden Candy', value: 50, chance: 0.08 },
                { name: 'Rainbow Sweet', value: 100, chance: 0.02 }
            ],
            'Star Box': [
                { name: 'Shooting Star', value: 25, chance: 0.35 },
                { name: 'Bright Star', value: 35, chance: 0.25 },
                { name: 'Golden Star', value: 50, chance: 0.2 },
                { name: 'Diamond Star', value: 75, chance: 0.15 },
                { name: 'Cosmic Star', value: 150, chance: 0.05 }
            ],
            'Golden Case': [
                { name: 'Golden Coin', value: 50, chance: 0.3 },
                { name: 'Golden Ring', value: 70, chance: 0.25 },
                { name: 'Golden Crown', value: 100, chance: 0.2 },
                { name: 'Golden Scepter', value: 150, chance: 0.15 },
                { name: 'Golden Throne', value: 300, chance: 0.1 }
            ],
            'Premium Box': [
                { name: 'Premium Token', value: 80, chance: 0.25 },
                { name: 'Premium Gem', value: 120, chance: 0.25 },
                { name: 'Premium Crystal', value: 180, chance: 0.2 },
                { name: 'Premium Diamond', value: 250, chance: 0.2 },
                { name: 'Premium Artifact', value: 500, chance: 0.1 }
            ],
            'Diamond Case': [
                { name: 'Diamond Shard', value: 150, chance: 0.2 },
                { name: 'Diamond Crystal', value: 200, chance: 0.2 },
                { name: 'Diamond Gem', value: 350, chance: 0.2 },
                { name: 'Diamond Crown', value: 500, chance: 0.2 },
                { name: 'Diamond Empire', value: 1000, chance: 0.2 }
            ]
        };
        
        const prizes = casePrizes[caseName] || casePrizes['Trial Box'];
        
        const random = Math.random();
        let cumulativeChance = 0;
        let wonPrize = prizes[prizes.length - 1];
        
        for (const prize of prizes) {
            cumulativeChance += prize.chance;
            if (random <= cumulativeChance) {
                wonPrize = prize;
                break;
            }
        }
        
        if (isTrialCase) {
            // Mark trial as used
            db.run('UPDATE users SET trial_used = 1 WHERE telegram_id = ?', [userId], (err) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }
                
                res.json({ 
                    success: true, 
                    prize: wonPrize,
                    trial: true,
                    message: 'Trial result - not added to inventory'
                });
            });
        } else {
            // Paid case - deduct balance and add to inventory
            db.run('UPDATE users SET balance = balance - ?, cases_opened = cases_opened + 1 WHERE telegram_id = ?', 
                   [casePrice, userId], (err) => {
                if (err) {
                    return res.status(500).json({ error: 'Failed to update balance' });
                }
                
                // Add to inventory
                db.run('INSERT INTO inventory (user_id, item_name, item_value, case_name) VALUES (?, ?, ?, ?)',
                       [userId, wonPrize.name, wonPrize.value, caseName], (err) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to add to inventory' });
                    }
                    
                    // Record transaction
                    db.run('INSERT INTO transactions (user_id, type, amount, status) VALUES (?, ?, ?, ?)',
                           [userId, 'case_open', -casePrice, 'confirmed']);
                    
                    res.json({ 
                        success: true, 
                        prize: wonPrize,
                        trial: false,
                        newBalance: user.balance - casePrice
                    });
                });
            });
        }
    });
});

// Check channel subscription
app.post('/api/check-subscription', async (req, res) => {
    const { userId } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
    }
    
    try {
        const isSubscribed = await checkChannelSubscription(userId);
        
        if (isSubscribed) {
            // Update user subscription status
            db.run('UPDATE users SET channel_subscribed = 1 WHERE telegram_id = ?', [userId], (err) => {
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }
                
                // Mark task as completed
                db.run('INSERT OR IGNORE INTO task_completions (user_id, task_id) VALUES (?, ?)',
                       [userId, 'subscription'], (err) => {
                    if (err) {
                        console.error('Error marking task completion:', err);
                    }
                });
                
                res.json({ subscribed: true });
            });
        } else {
            res.json({ subscribed: false });
        }
    } catch (error) {
        console.error('Error checking subscription:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get referral link
app.get('/api/referral/:userId', (req, res) => {
    const userId = req.params.userId;
    const referralLink = `https://t.me/@GrandSpinBot?start=${userId}`;
    
    res.json({ referralLink });
});

// Get tasks progress
app.get('/api/tasks/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], async (err, user) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Check current subscription status
        const isSubscribed = await checkChannelSubscription(userId);
        if (isSubscribed && !user.channel_subscribed) {
            db.run('UPDATE users SET channel_subscribed = 1 WHERE telegram_id = ?', [userId]);
        }
        
        // Get task completions
        db.all('SELECT task_id FROM task_completions WHERE user_id = ?', [userId], (err, completions) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            const completedTasks = completions.map(c => c.task_id);
            
            const tasks = [
                {
                    id: 'referrals',
                    title: 'Invite 5 people',
                    description: 'Invite 5 people to the bot',
                    progress: Math.min(user.referral_count, 5),
                    target: 5,
                    completed: user.referral_count >= 5 || completedTasks.includes('referrals'),
                    reward: '0.5 TON'
                },
                {
                    id: 'subscription',
                    title: 'Subscribe to channel',
                    description: 'Subscribe to our channel',
                    progress: isSubscribed ? 1 : 0,
                    target: 1,
                    completed: isSubscribed || completedTasks.includes('subscription'),
                    reward: '0.2 TON'
                },
                {
                    id: 'cases',
                    title: 'Open 5 cases',
                    description: 'Open 5 cases',
                    progress: Math.min(user.cases_opened, 5),
                    target: 5,
                    completed: user.cases_opened >= 5 || completedTasks.includes('cases'),
                    reward: '0.3 TON'
                },
                {
                    id: 'deposit',
                    title: 'Make deposit',
                    description: 'Make a deposit of 0.5 TON',
                    progress: user.total_deposited >= 0.5 ? 1 : 0,
                    target: 1,
                    completed: user.total_deposited >= 0.5 || completedTasks.includes('deposit'),
                    reward: '0.1 TON'
                }
            ];
            
            res.json(tasks);
        });
    });
});

// Claim task reward
app.post('/api/claim-task', (req, res) => {
    const { userId, taskId } = req.body;
    
    if (!userId || !taskId) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Check if task is already claimed
    db.get('SELECT * FROM task_completions WHERE user_id = ? AND task_id = ?', [userId, taskId], (err, completion) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (completion) {
            return res.status(400).json({ error: 'Task already claimed' });
        }
        
        // Get user and check task completion
        db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], (err, user) => {
            if (err || !user) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const taskRewards = {
                'referrals': { amount: 0.5, condition: user.referral_count >= 5 },
                'subscription': { amount: 0.2, condition: user.channel_subscribed },
                'cases': { amount: 0.3, condition: user.cases_opened >= 5 },
                'deposit': { amount: 0.1, condition: user.total_deposited >= 0.5 }
            };
            
            const task = taskRewards[taskId];
            if (!task || !task.condition) {
                return res.status(400).json({ error: 'Task not completed' });
            }
            
            // Mark task as completed and give reward
            db.run('INSERT INTO task_completions (user_id, task_id) VALUES (?, ?)', [userId, taskId], (err) => {
                if (err) {
                    return res.status(500).json({ error: 'Failed to claim task' });
                }
                
                // Add reward to balance
                db.run('UPDATE users SET balance = balance + ? WHERE telegram_id = ?', [task.amount, userId], (err) => {
                    if (err) {
                        return res.status(500).json({ error: 'Failed to add reward' });
                    }
                    
                    // Record transaction
                    db.run('INSERT INTO transactions (user_id, type, amount, status) VALUES (?, ?, ?, ?)',
                           [userId, 'task_reward', task.amount, 'confirmed']);
                    
                    res.json({ 
                        success: true, 
                        reward: task.amount,
                        newBalance: user.balance + task.amount
                    });
                });
            });
        });
    });
});

// Process TON Connect transaction
app.post('/api/process-transaction', async (req, res) => {
    const { userId, transactionHash, amount } = req.body;
    
    if (!userId || !transactionHash || !amount) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    try {
        // Verify transaction exists and is valid
        const response = await axios.get(`https://tonapi.io/v2/transactions/${transactionHash}`, {
            headers: { 'Authorization': `Bearer ${TON_API_KEY}` }
        });
        
        const transaction = response.data;
        if (transaction && transaction.out_msgs && transaction.out_msgs.length > 0) {
            const outMsg = transaction.out_msgs[0];
            if (outMsg.destination && outMsg.destination.address === REAL_TON_WALLET) {
                const txAmount = parseInt(outMsg.value) / 1e9;
                
                if (Math.abs(txAmount - amount) < 0.001) { // Allow small differences due to fees
                    // Check if already processed
                    db.get('SELECT * FROM transactions WHERE tx_hash = ?', [transactionHash], (err, existingTx) => {
                        if (err || existingTx) {
                            return res.status(400).json({ error: 'Transaction already processed' });
                        }
                        
                        // Process the transaction
                        db.run('UPDATE users SET balance = balance + ? WHERE telegram_id = ?', [txAmount, userId], (err) => {
                            if (err) {
                                return res.status(500).json({ error: 'Failed to update balance' });
                            }
                            
                            // Record transaction
                            db.run('INSERT INTO transactions (user_id, type, amount, tx_hash, status) VALUES (?, ?, ?, ?, ?)',
                                   [userId, 'tonconnect_payment', txAmount, transactionHash, 'confirmed']);
                            
                            res.json({ success: true, amount: txAmount });
                        });
                    });
                } else {
                    res.status(400).json({ error: 'Transaction amount mismatch' });
                }
            } else {
                res.status(400).json({ error: 'Invalid transaction destination' });
            }
        } else {
            res.status(400).json({ error: 'Invalid transaction' });
        }
    } catch (error) {
        console.error('Error processing transaction:', error);
        res.status(500).json({ error: 'Failed to verify transaction' });
    }
});

// Periodic deposit checker
setInterval(async () => {
    console.log('Checking for pending deposits...');
    
    db.all('SELECT DISTINCT user_id FROM pending_deposits WHERE created_at > datetime("now", "-1 hour")', [], async (err, deposits) => {
        if (err) {
            console.error('Error fetching pending deposits:', err);
            return;
        }
        
        for (const deposit of deposits) {
            try {
                const transaction = await checkTonTransaction(deposit.user_id, 0.01);
                if (transaction) {
                    // Check if transaction already processed
                    db.get('SELECT * FROM transactions WHERE tx_hash = ?', [transaction.hash], (err, existingTx) => {
                        if (err || existingTx) return;
                        
                        // Update user balance
                        db.run('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE telegram_id = ?', 
                               [transaction.amount, transaction.amount, deposit.user_id], (err) => {
                            if (err) {
                                console.error('Error updating balance:', err);
                                return;
                            }
                            
                            // Record transaction
                            db.run('INSERT INTO transactions (user_id, type, amount, tx_hash, status) VALUES (?, ?, ?, ?, ?)',
                                   [deposit.user_id, 'deposit', transaction.amount, transaction.hash, 'confirmed']);
                            
                            // Remove from pending deposits
                            db.run('DELETE FROM pending_deposits WHERE user_id = ?', [deposit.user_id]);
                            
                            // Notify user
                            bot.sendMessage(deposit.user_id, `✅ Deposit confirmed! You received ${transaction.amount} TON`);
                        });
                    });
                }
            } catch (error) {
                console.error('Error checking deposit for user', deposit.user_id, ':', error);
            }
        }
    });
}, 30000); // Check every 30 seconds

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebApp URL: ${WEBAPP_URL}`);
    console.log(`TON Connect manifest: ${WEBAPP_URL}tonconnect-manifest.json`);
    console.log(`Bot Token: ${BOT_TOKEN ? 'Set' : 'Missing'}`);
});

// Process error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('Database connection closed');
        }
        process.exit(0);
    });
});
