// server.js - Fixed version

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://ioioning.github.io/spingame/';
const TON_API_KEY = process.env.TON_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID || '@openingcases';
const PORT = process.env.PORT || 3000;
const REAL_TON_WALLET = process.env.TON_WALLET_ADDRESS;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Generate unique wallet address for user
function generateWalletAddress(userId) {
    const hash = crypto.createHash('sha256').update(userId + 'grandspin_salt').digest('hex');
    return 'UQ' + hash.substring(0, 46);
}

// Remove the problematic code blocks that were causing the error
// These lines were using undefined variables:
// const depositInfo = ...
// bot.sendMessage(chatId, depositInfo, { parse_mode: 'Markdown' });

bot.onText(/\/deposit/, (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    // Используем реальный кошелек вместо генерированного
    const walletAddress = REAL_TON_WALLET;
    const depositComment = userId;

    const depositInfo =
        `*Replenishment*\n\n` +
        `Send TON to this address:\n\`${walletAddress}\`\n\n` +
        `In the comment to the payment, insert:\n\`${depositComment}\`\n\n` +
        `*Important:* The comment must be ONLY:\n\`${depositComment}\``;

    bot.sendMessage(chatId, depositInfo, { parse_mode: 'Markdown' });
});

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
                            
                            bot.sendMessage(referralCode, 'You received 0.1 TON for inviting a friend!');
                        }
                    });
                }
            });
        }

// В bot.onText(/\/start(.*)/, замените клавиатуру на:
const keyboard = {
    inline_keyboard: [
        [{ text: ' Connect Wallet', web_app: { url: `${WEBAPP_URL}?tab=connect` } }],
        [{ text: ' Open App', web_app: { url: WEBAPP_URL } }]
    ]
};
        bot.sendMessage(chatId, 
            `Welcome to GrandSpin Bot!\n\n` +
            `Open cases and get cool NFT gifts!\n\n` +
            `Free trial case available\n` +
            `Complete tasks and get bonuses\n` +
            `Invite friends and earn TON`,
            { reply_markup: keyboard }
        );
    });
});

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
                walletAddress: user.wallet_address,
                amount: amount
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
        
        // Generate random prize
        const prizes = [
            { name: 'Diamond NFT', value: 100, chance: 0.001 },
            { name: 'Golden Trophy', value: 65, chance: 0.002 },
            { name: 'Star Gift', value: 35, chance: 0.005 },
            { name: 'Premium Box', value: 25, chance: 0.01 },
            { name: 'Sweet Candy', value: 15, chance: 0.05 },
            { name: 'Party Gift', value: 10, chance: 0.1 },
            { name: 'Fire Token', value: 8, chance: 0.15 },
            { name: 'Magic Star', value: 5, chance: 0.2 },
            { name: 'Lucky Charm', value: 3, chance: 0.25 },
            { name: 'Sparkle', value: 1, chance: 0.213 }
        ];
        
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
    const referralLink = `https://t.me/YourBotUsername?start=${userId}`;
    
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

// Periodic deposit checker
setInterval(async () => {
    console.log('Checking for pending deposits...');
    
    db.all('SELECT DISTINCT user_id, wallet_address FROM pending_deposits WHERE created_at > datetime("now", "-1 hour")', [], async (err, deposits) => {
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
