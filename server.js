const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

// Configuration
const BOT_TOKEN = '7507829383:AAGJ0ge6WCGgyv84DywksZIFqELrBZbng3M'; // Замените на токен вашего бота
const WEBAPP_URL = 'https://ioioning.github.io/spingame/'; // URL вашего веб-приложения
const TON_API_KEY = 'AFPMHTH2LOT5MSQAAAAHNAC2V44UZKJSV6CBP22B5HGHIPD6WUOKNFQUR7SXMZQVPOYG3YA'; // Ключ для TON API
const CHANNEL_ID = '@openingcases'; // ID канала для проверки подписки
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public'));

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Transactions table
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        type TEXT, -- 'deposit', 'case_open', 'referral_bonus'
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
});

// Generate unique wallet address for user
function generateWalletAddress(userId) {
    const hash = crypto.createHash('sha256').update(userId + 'salt').digest('hex');
    return 'UQ' + hash.substring(0, 46) + 'JMMp';
}

// Check TON transaction
async function checkTonTransaction(address, amount) {
    try {
        const response = await axios.get(`https://tonapi.io/v2/accounts/${address}/transactions`, {
            headers: {
                'Authorization': `Bearer ${TON_API_KEY}`
            }
        });
        
        const transactions = response.data.transactions;
        const recentTransactions = transactions.filter(tx => 
            tx.in_msg && 
            tx.in_msg.value && 
            parseInt(tx.in_msg.value) >= amount * 1000000000 && // Convert TON to nanoTON
            Date.now() - tx.utime * 1000 < 3600000 // Last hour
        );
        
        return recentTransactions.length > 0 ? recentTransactions[0] : null;
    } catch (error) {
        console.error('Error checking TON transaction:', error);
        return null;
    }
}

// Check if user is subscribed to channel
async function checkChannelSubscription(userId) {
    try {
        const member = await bot.getChatMember(CHANNEL_ID, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        console.error('Error checking channel subscription:', error);
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
            console.error(err);
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
                    console.error(err);
                    return;
                }

                // Handle referral
                if (referralCode && referralCode !== userId) {
                    db.get('SELECT * FROM users WHERE telegram_id = ?', [referralCode], (err, referrer) => {
                        if (!err && referrer) {
                            // Add referral
                            db.run('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)', 
                                   [referralCode, userId]);
                            
                            // Update referrer's count
                            db.run('UPDATE users SET referral_count = referral_count + 1 WHERE telegram_id = ?', 
                                   [referralCode]);
                            
                            // Give bonus to referrer
                            db.run('UPDATE users SET balance = balance + 0.5 WHERE telegram_id = ?', 
                                   [referralCode]);
                            
                            bot.sendMessage(referralCode, 'you received 0.1 ton for inviting a friend!');
                        }
                    });
                }
            });
        }

        // Send welcome message
        const keyboard = {
            inline_keyboard: [[
                { text: 'Open app', web_app: { url: WEBAPP_URL } }
            ]]
        };

        bot.sendMessage(chatId, 
	`Welcome to GrandSpin Bot!\n\n` +
        `Open cases and get cool NFT gifts!\n\n` +
        `Trial case - FREE\n` +
        ` Complete tasks and get bonuses\n` +
        ` Invite friends and earn TON`,
            { reply_markup: keyboard }
        );
    });
});

// API Routes

// Get user data
app.get('/api/user/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
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
            walletAddress: user.wallet_address
        });
    });
});

// Get user inventory
app.get('/api/inventory/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.all('SELECT * FROM inventory WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, items) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        res.json(items);
    });
});

// Check deposit
app.post('/api/check-deposit', async (req, res) => {
    const { userId, amount } = req.body;
    
    try {
        db.get('SELECT wallet_address FROM users WHERE telegram_id = ?', [userId], async (err, user) => {
            if (err || !user) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            const transaction = await checkTonTransaction(user.wallet_address, amount);
            
            if (transaction) {
                // Update user balance
                db.run('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE telegram_id = ?', 
                       [amount, amount, userId]);
                
                // Record transaction
                db.run('INSERT INTO transactions (user_id, type, amount, tx_hash, status) VALUES (?, ?, ?, ?, ?)',
                       [userId, 'deposit', amount, transaction.hash, 'confirmed']);
                
                res.json({ success: true, transaction: transaction.hash });
            } else {
                res.json({ success: false, message: 'Transaction not found' });
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Open case
app.post('/api/open-case', (req, res) => {
    const { userId, caseName, casePrice } = req.body;
    
    db.get('SELECT balance FROM users WHERE telegram_id = ?', [userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Check if it's a trial case or user has enough balance
        if (caseName !== 'Trial Box' && user.balance < casePrice) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // Generate random prize
        const prizes = [
            { name: 'Diamond NFT', value: 100, chance: 0.01 },
            { name: 'Golden Trophy', value: 65, chance: 0.02 },
            { name: 'Star Gift', value: 35, chance: 0.05 },
            { name: 'Premium Box', value: 25, chance: 0.1 },
            { name: 'Sweet Candy', value: 15, chance: 0.15 },
            { name: 'Party Gift', value: 10, chance: 0.2 },
            { name: 'Fire Token', value: 8, chance: 0.25 },
            { name: 'Magic Star', value: 5, chance: 0.3 },
            { name: 'Lucky Charm', value: 3, chance: 0.4 },
            { name: 'Sparkle', value: 1, chance: 0.6 }
        ];
        
        const random = Math.random();
        let cumulativeChance = 0;
        let wonPrize = prizes[prizes.length - 1]; // Default to lowest prize
        
        for (const prize of prizes) {
            cumulativeChance += prize.chance;
            if (random <= cumulativeChance) {
                wonPrize = prize;
                break;
            }
        }
        
        if (caseName === 'Trial Box') {
            // Trial case - don't deduct balance or add to inventory
            res.json({ 
                success: true, 
                prize: wonPrize,
                trial: true,
                message: 'Trial result - not added to inventory'
            });
        } else {
            // Real case - deduct balance and add to inventory
            db.run('UPDATE users SET balance = balance - ?, cases_opened = cases_opened + 1 WHERE telegram_id = ?', 
                   [casePrice, userId], (err) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }
                
                // Add to inventory
                db.run('INSERT INTO inventory (user_id, item_name, item_value, case_name) VALUES (?, ?, ?, ?)',
                       [userId, wonPrize.name, wonPrize.value, caseName]);
                
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
        }
    });
});

// Check channel subscription
app.post('/api/check-subscription', async (req, res) => {
    const { userId } = req.body;
    
    try {
        const isSubscribed = await checkChannelSubscription(userId);
        
        if (isSubscribed) {
            // Update user subscription status
            db.run('UPDATE users SET channel_subscribed = 1 WHERE telegram_id = ?', [userId]);
            
            res.json({ subscribed: true });
        } else {
            res.json({ subscribed: false });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get referral link
app.get('/api/referral/:userId', (req, res) => {
    const userId = req.params.userId;
    const referralLink = `https://t.me/GrandSpinBot?start=${userId}`;
    
    res.json({ referralLink });
});

// Get tasks progress
app.get('/api/tasks/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.get('SELECT * FROM users WHERE telegram_id = ?', [userId], async (err, user) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Check current subscription status
        const isSubscribed = await checkChannelSubscription(userId);
        if (isSubscribed && !user.channel_subscribed) {
            db.run('UPDATE users SET channel_subscribed = 1 WHERE telegram_id = ?', [userId]);
        }
        
        const tasks = [
            {
                id: 'referrals',
                title: 'Invite 20 peaple',
                description: 'Invite 20 people to the bot',
                progress: Math.min(user.referral_count, 20),
                target: 20,
                completed: user.referral_count >= 20
            },
            {
                id: 'subscription',
                title: 'Subscribe on channel',
                description: 'Subscribe on channel',
                progress: isSubscribed ? 1 : 0,
                target: 1,
                completed: isSubscribed
            },
            {
                id: 'cases',
                title: 'open cases',
                description: 'open 10 cases',
                progress: Math.min(user.cases_opened, 10),
                target: 10,
                completed: user.cases_opened >= 10
            },
            {
                id: 'deposit',
                title: 'Пополнить баланс',
                description: 'Пополните баланс на 1 TON',
                progress: Math.min(user.total_deposited, 1),
                target: 1,
                completed: user.total_deposited >= 1
            }
        ];
        
        res.json(tasks);
    });
});

// Periodic deposit checker
setInterval(async () => {
    db.all('SELECT telegram_id, wallet_address FROM users WHERE balance < 1000', [], async (err, users) => {
        if (err) return;
        
        for (const user of users) {
            try {
                const transaction = await checkTonTransaction(user.wallet_address, 0.01);
                if (transaction) {
                    const amount = parseInt(transaction.in_msg.value) / 1000000000;
                    
                    db.run('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE telegram_id = ?', 
                           [amount, amount, user.telegram_id]);
                    
                    db.run('INSERT INTO transactions (user_id, type, amount, tx_hash, status) VALUES (?, ?, ?, ?, ?)',
                           [user.telegram_id, 'deposit', amount, transaction.hash, 'confirmed']);
                    
                    bot.sendMessage(user.telegram_id, `Deposit succesful! you for: ${amount} TON`);
                }
            } catch (error) {
                console.error('Error checking deposits:', error);
            }
        }
    });
}, 60000); // Check every minute

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});
