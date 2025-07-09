// server.js - Updated with TON Connect integration

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

// Database initialization
const db = new sqlite3.Database('bot.db');

// Create tables (включая новую таблицу для TON Connect)
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

    // Добавляем таблицу для TON Connect кошельков
    db.run(`CREATE TABLE IF NOT EXISTS connected_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        wallet_address TEXT,
        wallet_type TEXT,
        is_active BOOLEAN DEFAULT 1,
        connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, wallet_address)
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

// TON Connect endpoints
app.post('/api/connect-wallet', (req, res) => {
    const { userId, walletAddress, walletType } = req.body;
    
    if (!userId || !walletAddress) {
        return res.status(400).json({ error: 'User ID and wallet address are required' });
    }
    
    // Сохраняем подключенный кошелек
    db.run(`INSERT OR REPLACE INTO connected_wallets (user_id, wallet_address, wallet_type) 
            VALUES (?, ?, ?)`, 
           [userId, walletAddress, walletType || 'unknown'], 
           function(err) {
        if (err) {
            console.error('Error saving wallet connection:', err);
            return res.status(500).json({ error: 'Failed to save wallet connection' });
        }
        
        res.json({ 
            success: true, 
            message: 'Wallet connected successfully',
            walletAddress 
        });
    });
});

app.post('/api/disconnect-wallet', (req, res) => {
    const { userId, walletAddress } = req.body;
    
    if (!userId || !walletAddress) {
        return res.status(400).json({ error: 'User ID and wallet address are required' });
    }
    
    db.run('UPDATE connected_wallets SET is_active = 0 WHERE user_id = ? AND wallet_address = ?', 
           [userId, walletAddress], 
           function(err) {
        if (err) {
            console.error('Error disconnecting wallet:', err);
            return res.status(500).json({ error: 'Failed to disconnect wallet' });
        }
        
        res.json({ 
            success: true, 
            message: 'Wallet disconnected successfully' 
        });
    });
});

app.get('/api/connected-wallets/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.all('SELECT * FROM connected_wallets WHERE user_id = ? AND is_active = 1 ORDER BY connected_at DESC', 
           [userId], 
           (err, wallets) => {
        if (err) {
            console.error('Error fetching connected wallets:', err);
            return res.status(500).json({ error: 'Failed to fetch connected wallets' });
        }
        
        res.json(wallets);
    });
});

// TON Connect transaction verification
app.post('/api/verify-ton-transaction', async (req, res) => {
    const { userId, txHash, amount } = req.body;
    
    if (!userId || !txHash || !amount) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    try {
        // Получаем подключенные кошельки пользователя
        db.get('SELECT wallet_address FROM connected_wallets WHERE user_id = ? AND is_active = 1', 
               [userId], 
               async (err, wallet) => {
            if (err || !wallet) {
                return res.status(404).json({ error: 'No connected wallet found' });
            }
            
            // Проверяем транзакцию через TON API
            try {
                const response = await axios.get(`https://tonapi.io/v2/traces/${txHash}`, {
                    headers: { 'Authorization': `Bearer ${TON_API_KEY}` }
                });
                
                const trace = response.data;
                const transaction = trace.transaction;
                
                // Проверяем, что транзакция валидна
                if (transaction && transaction.in_msg && transaction.in_msg.value) {
                    const txAmount = parseInt(transaction.in_msg.value) / 1e9;
                    
                    if (txAmount >= amount) {
                        // Проверяем, не обработана ли уже эта транзакция
                        db.get('SELECT * FROM transactions WHERE tx_hash = ?', [txHash], (err, existingTx) => {
                            if (err) {
                                return res.status(500).json({ error: 'Database error' });
                            }
                            
                            if (existingTx) {
                                return res.json({ success: false, message: 'Transaction already processed' });
                            }
                            
                            // Обновляем баланс пользователя
                            db.run('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE telegram_id = ?', 
                                   [txAmount, txAmount, userId], 
                                   (err) => {
                                if (err) {
                                    return res.status(500).json({ error: 'Failed to update balance' });
                                }
                                
                                // Записываем транзакцию
                                db.run('INSERT INTO transactions (user_id, type, amount, tx_hash, status) VALUES (?, ?, ?, ?, ?)',
                                       [userId, 'ton_connect_deposit', txAmount, txHash, 'confirmed']);
                                
                                res.json({ 
                                    success: true, 
                                    amount: txAmount,
                                    message: 'Transaction verified successfully'
                                });
                            });
                        });
                    } else {
                        res.json({ success: false, message: 'Transaction amount too low' });
                    }
                } else {
                    res.json({ success: false, message: 'Invalid transaction' });
                }
            } catch (apiError) {
                console.error('TON API error:', apiError);
                res.status(500).json({ error: 'Failed to verify transaction' });
            }
        });
    } catch (error) {
        console.error('Error verifying transaction:', error);
        res.status(500).json({ error: 'Server error' });
    }
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

// Deposit command with TON Connect support
bot.onText(/\/deposit/, (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    
    const walletAddress = REAL_TON_WALLET;
    const depositComment = userId;

    const depositInfo =
        `*💰 Пополнение баланса*\n\n` +
        `Выберите способ пополнения:\n\n` +
        `🔹 *Через TON Connect:*\n` +
        `Подключите кошелек через веб-приложение\n\n` +
        `🔹 *Прямой перевод:*\n` +
        `Отправьте TON на адрес:\n\`${walletAddress}\`\n\n` +
        `В комментарии к платежу укажите:\n\`${depositComment}\`\n\n` +
        `*Важно:* Комментарий должен быть ТОЛЬКО:\n\`${depositComment}\``;

    const keyboard = {
        inline_keyboard: [
            [{ text: '💳 Подключить кошелек', web_app: { url: `${WEBAPP_URL}?tab=connect` } }],
            [{ text: '📱 Открыть приложение', web_app: { url: WEBAPP_URL } }]
        ]
    };

    bot.sendMessage(chatId, depositInfo, { 
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
});

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
                            
                            bot.sendMessage(referralCode, '🎉 Вы получили 0.1 TON за приглашение друга!');
                        }
                    });
                }
            });
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: '💳 Подключить кошелек', web_app: { url: `${WEBAPP_URL}?tab=connect` } }],
                [{ text: '🎮 Открыть приложение', web_app: { url: WEBAPP_URL } }]
            ]
        };

        bot.sendMessage(chatId, 
            `🎰 *Добро пожаловать в GrandSpin Bot!*\n\n` +
            `🎁 Открывайте кейсы и получайте крутые NFT подарки!\n\n` +
            `✨ Доступен бесплатный пробный кейс\n` +
            `🎯 Выполняйте задания и получайте бонусы\n` +
            `👥 Приглашайте друзей и зарабатывайте TON\n\n` +
            `💎 Подключите TON кошелек для удобных переводов!`,
            { 
                parse_mode: 'Markdown',
                reply_markup: keyboard 
            }
        );
    });
});

// Get user data (обновлено для TON Connect)
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
        
        // Получаем подключенные кошельки
        db.all('SELECT wallet_address, wallet_type FROM connected_wallets WHERE user_id = ? AND is_active = 1', 
               [userId], 
               (err, wallets) => {
            if (err) {
                console.error('Error fetching wallets:', err);
                wallets = [];
            }
            
            res.json({
                balance: user.balance,
                referralCount: user.referral_count,
                channelSubscribed: user.channel_subscribed,
                casesOpened: user.cases_opened,
                totalDeposited: user.total_deposited,
                walletAddress: user.wallet_address,
                trialUsed: user.trial_used,
                connectedWallets: wallets
            });
        });
    });
});

// Остальные endpoints остаются прежними...
// (Все остальные endpoints из оригинального кода)

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
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 WebApp URL: ${WEBAPP_URL}`);
    console.log(`🤖 Bot Token: ${BOT_TOKEN ? 'Set' : 'Missing'}`);
    console.log(`💎 TON Connect integration: Enabled`);
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
