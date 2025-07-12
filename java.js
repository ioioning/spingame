// TON Connect initialization
let tonConnectUI;
let connectedWallet = null;
let currentTab = 'home';
let userBalance = 0.07;
let currentCasePrice = 0;
let currentCaseName = '';
let isSpinning = false;
let isTrialCase = false;

// Initialize TON Connect
async function initTonConnect() {
    try {
        tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
            manifestUrl: 'https://raw.githubusercontent.com/ton-community/tutorials/main/03-client/test/public/tonconnect-manifest.json'
        });

        // Listen for wallet connection status
        tonConnectUI.onStatusChange((wallet) => {
            if (wallet) {
                connectedWallet = wallet;
                updateWalletUI(true);
                getWalletBalance();
            } else {
                connectedWallet = null;
                updateWalletUI(false);
            }
        });

        // Set up connect button
        const connectBtn = document.getElementById('connect-wallet-btn');
        if (connectBtn) {
            connectBtn.addEventListener('click', () => {
                tonConnectUI.openModal();
            });
        }

        // Set up disconnect button
        const disconnectBtn = document.getElementById('disconnect-wallet-btn');
        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', () => {
                tonConnectUI.disconnect();
            });
        }

    } catch (error) {
        console.error('TON Connect initialization failed:', error);
    }
}

// Update wallet UI
function updateWalletUI(connected) {
    const disconnectedEl = document.getElementById('wallet-disconnected');
    const connectedEl = document.getElementById('wallet-connected');
    const walletSection = document.getElementById('wallet-section');

    if (connected && connectedWallet) {
        if (disconnectedEl) disconnectedEl.style.display = 'none';
        if (connectedEl) connectedEl.style.display = 'block';
        if (walletSection) walletSection.classList.add('wallet-connected');

        const address = connectedWallet.account.address;
        const shortAddress = address.slice(0, 8) + '...' + address.slice(-6);
        const walletAddressEl = document.getElementById('wallet-address');
        if (walletAddressEl) walletAddressEl.textContent = shortAddress;
    } else {
        if (disconnectedEl) disconnectedEl.style.display = 'block';
        if (connectedEl) connectedEl.style.display = 'none';
        if (walletSection) walletSection.classList.remove('wallet-connected');
    }
}

// Get wallet balance
async function getWalletBalance() {
    if (!connectedWallet) return;

    try {
        const balanceEl = document.getElementById('wallet-balance');
        if (balanceEl) balanceEl.textContent = 'Loading...';

        setTimeout(() => {
            if (balanceEl) balanceEl.textContent = '0.00 TON';
        }, 1000);
    } catch (error) {
        console.error('Error fetching balance:', error);
        const balanceEl = document.getElementById('wallet-balance');
        if (balanceEl) balanceEl.textContent = 'Error loading balance';
    }
}

// Send transaction
async function sendTransaction(amount) {
    if (!connectedWallet) {
        alert('Please connect your wallet first');
        return false;
    }

    try {
        const transaction = {
            validUntil: Math.floor(Date.now() / 1000) + 300,
            messages: [
                {
                    address: 'UQDx5LBGp7K7A5hrYu4y6W5RPO4hwk5fL_LWzov0FlYeJMMp',
                    amount: (amount * 1000000000).toString(),
                    payload: btoa('Case opening payment')
                }
            ]
        };

        const result = await tonConnectUI.sendTransaction(transaction);
        return result;
    } catch (error) {
        console.error('Transaction failed:', error);
        alert('Transaction failed: ' + error.message);
        return false;
    }
}

// Switch tabs
function switchTab(tab) {
    // Hide all sections
    const sections = ['home-section', 'profile-section', 'tasks-section'];
    sections.forEach(sectionId => {
        const element = document.getElementById(sectionId);
        if (element) element.style.display = 'none';
    });

    // Show selected section
    const selectedSection = document.getElementById(tab + '-section');
    if (selectedSection) selectedSection.style.display = 'block';

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });

    // Find the clicked nav item
    const clickedItem = event ? event.target.closest('.nav-item') : document.querySelector('.nav-item');
    if (clickedItem) clickedItem.classList.add('active');

    // Show/hide balance in header
    const balance = document.getElementById('balance');
    if (balance) {
        if (tab === 'home' || tab === 'tasks') {
            balance.style.display = 'flex';
        } else {
            balance.style.display = 'none';
        }
    }

    currentTab = tab;
}

// Show case prizes
function showCasePrizes(caseName) {
    const caseTitleEl = document.getElementById('case-title');
    if (caseTitleEl) caseTitleEl.textContent = caseName;

    const caseData = {
        'Trial Box': 0,
        'Sweet Box': 5,
        'Star Box': 15,
        'Golden Case': 35,
        'Premium Box': 65,
        'Diamond Case': 100
    };

    currentCasePrice = caseData[caseName];
    currentCaseName = caseName;
    isTrialCase = caseName === 'Trial Box';

    // Sample prizes data
    const prizes = [
        { icon: '💰', value: '100 TON' },
        { icon: '💎', value: '65 TON' },
        { icon: '🏆', value: '35 TON' },
        { icon: '🎁', value: '25 TON' },
        { icon: '⭐', value: '15 TON' },
        { icon: '🪙', value: '10 TON' },
        { icon: '💰', value: '8 TON' },
        { icon: '🎯', value: '5 TON' },
        { icon: '🎪', value: '3 TON' }
    ];

    const prizesContainer = document.getElementById('case-prizes');
    if (prizesContainer) {
        prizesContainer.innerHTML = prizes.map(prize => `
            <div class="prize-item">
                <div class="prize-icon">${prize.icon}</div>
                <div class="prize-value">${prize.value}</div>
            </div>
        `).join('');
    }

    const spinBtn = document.getElementById('spin-btn');
    const insufficientFunds = document.getElementById('insufficient-funds');
    const trialNotice = document.getElementById('trial-notice');

    if (isTrialCase) {
        if (spinBtn) {
            spinBtn.disabled = false;
            spinBtn.textContent = 'TRY FOR FREE';
            spinBtn.classList.add('trial');
        }
        if (insufficientFunds) insufficientFunds.style.display = 'none';
        if (trialNotice) trialNotice.style.display = 'block';
    } else {
        if (spinBtn) {
            spinBtn.classList.remove('trial');
            if (userBalance >= currentCasePrice) {
                spinBtn.disabled = false;
                spinBtn.textContent = `SPIN (${currentCasePrice} TON)`;
                if (insufficientFunds) insufficientFunds.style.display = 'none';
            } else {
                spinBtn.disabled = true;
                spinBtn.textContent = 'INSUFFICIENT FUNDS';
                if (insufficientFunds) insufficientFunds.style.display = 'block';
            }
        }
        if (trialNotice) trialNotice.style.display = 'none';
    }

    // Reset spin UI
    const spinnerContainer = document.getElementById('spinner-container');
    const spinResult = document.getElementById('spin-result');
    const spinSection = document.getElementById('spin-section');
    
    if (spinnerContainer) spinnerContainer.style.display = 'none';
    if (spinResult) {
        spinResult.classList.remove('show');
        spinResult.classList.remove('trial');
    }
    if (spinSection) spinSection.style.display = 'block';

    const modal = document.getElementById('case-modal');
    if (modal) modal.style.display = 'flex';
}

// Start spin with wallet
function startSpinWithWallet() {
    if (isSpinning) return;

    if (isTrialCase) {
        startSpin();
        return;
    }

    if (!connectedWallet) {
        alert('Please connect your wallet to open cases');
        return;
    }

    // Send transaction first
    sendTransaction(currentCasePrice).then((result) => {
        if (result) {
            startSpin();
        }
    });
}

// Start spin animation
function startSpin() {
    if (isSpinning) return;
    
    isSpinning = true;
    
    // Deduct balance only if not trial case
    if (!isTrialCase) {
        userBalance -= currentCasePrice;
        updateBalanceDisplay();
    }
    
    // Hide spin button and show spinner
    const spinSection = document.getElementById('spin-section');
    const spinnerContainer = document.getElementById('spinner-container');
    
    if (spinSection) spinSection.style.display = 'none';
    if (spinnerContainer) spinnerContainer.style.display = 'block';
    
    // Generate spinner items
    const spinnerTrack = document.getElementById('spinner-track');
    const prizes = [
        { value: '100 TON', icon: '💰' },
        { value: '65 TON', icon: '💎' },
        { value: '35 TON', icon: '🏆' },
        { value: '25 TON', icon: '🎁' },
        { value: '15 TON', icon: '⭐' },
        { value: '10 TON', icon: '🪙' },
        { value: '8 TON', icon: '💰' },
        { value: '5 TON', icon: '🎯' },
        { value: '3 TON', icon: '🎪' },
        { value: '2 TON', icon: '🎲' },
        { value: '1 TON', icon: '🎊' },
        { value: '0.5 TON', icon: '🎈' }
    ];
    
    // Create multiple sets of prizes for continuous spinning
    const spinnerItems = [];
    for (let i = 0; i < 5; i++) {
        spinnerItems.push(...prizes);
    }
    
    if (spinnerTrack) {
        spinnerTrack.innerHTML = spinnerItems.map(prize => `
            <div class="spinner-item">
                <div class="spinner-item-icon">${prize.icon}</div>
                <div class="spinner-item-value">${prize.value}</div>
            </div>
        `).join('');
    }
    
    // Calculate winning position
    const winnerIndex = Math.floor(Math.random() * prizes.length);
    const winnerValue = prizes[winnerIndex].value;
    const winnerIcon = prizes[winnerIndex].icon;

    // Calculate spin distance
    const itemWidth = 110;
    const totalWidth = itemWidth * spinnerItems.length;
    const finalPosition = -(totalWidth - itemWidth * (winnerIndex + prizes.length * 2 + 5));

    // Start spinning animation
    if (spinnerTrack) {
        spinnerTrack.style.transform = `translateX(${finalPosition}px)`;
    }

    // After animation completes
    setTimeout(() => {
        // Mark winner
        const allItems = document.querySelectorAll('.spinner-item');
        const targetIndex = winnerIndex + prizes.length * 2 + 5;
        if (allItems[targetIndex]) {
            allItems[targetIndex].classList.add('winner-item');
        }

        // Show result
        setTimeout(() => {
            if (spinnerContainer) spinnerContainer.style.display = 'none';
            
            const resultDiv = document.getElementById('spin-result');
            const resultTitle = document.getElementById('result-title');
            const resultValue = document.getElementById('result-value');

            if (isTrialCase) {
                if (resultDiv) resultDiv.classList.add('trial');
                if (resultTitle) {
                    resultTitle.classList.add('trial');
                    resultTitle.textContent = 'Trial Result (Not Real)';
                }
            } else {
                if (resultTitle) resultTitle.textContent = 'You won!';
            }

            if (resultValue) resultValue.textContent = `${winnerIcon} ${winnerValue}`;
            if (resultDiv) resultDiv.classList.add('show');

            isSpinning = false;
        }, 1000);
    }, 3000);
}

// Update balance display
function updateBalanceDisplay() {
    const balanceEl = document.getElementById('balance');
    if (balanceEl) {
        balanceEl.innerHTML = `
            <div class="balance-icon"></div>
            <span>${userBalance.toFixed(2)} TON</span>
        `;
    }
}

// Show/close deposit modal
function showDepositModal() {
    const modal = document.getElementById('deposit-modal');
    if (modal) modal.style.display = 'flex';
}

function closeDepositModal() {
    const modal = document.getElementById('deposit-modal');
    if (modal) modal.style.display = 'none';
}

// Close case modal
function closeCaseModal() {
    const modal = document.getElementById('case-modal');
    if (modal) modal.style.display = 'none';
}

// Copy address
function copyAddress() {
    const address = "UQDx5LBGp7K7A5hrYu4y6W5RPO4hwk5fL_LWzov0FlYeJMMp";
    navigator.clipboard.writeText(address).then(() => {
        alert('Address copied to clipboard!');
    }).catch(() => {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = address;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        alert('Address copied to clipboard!');
    });
}

// Share bot
function shareBot() {
    const url = 'https://t.me/GrandSpinBot';
    const text = 'Check out this amazing case opening bot!';
    if (window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
    } else {
        window.open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`, '_blank');
    }
}

// Open channel
function openChannel() {
    if (window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.openTelegramLink('https://t.me/openingcases');
    } else {
        window.open('https://t.me/openingcases', '_blank');
    }
}

// Additional utility functions
function formatBalance(balance) {
    return balance.toFixed(2);
}

function generateRandomPrize() {
    const prizes = [
        { value: 100, icon: '💰', rarity: 0.01 },
        { value: 65, icon: '💎', rarity: 0.02 },
        { value: 35, icon: '🏆', rarity: 0.05 },
        { value: 25, icon: '🎁', rarity: 0.08 },
        { value: 15, icon: '⭐', rarity: 0.12 },
        { value: 10, icon: '🪙', rarity: 0.15 },
        { value: 8, icon: '💰', rarity: 0.17 },
        { value: 5, icon: '🎯', rarity: 0.2 },
        { value: 3, icon: '🎪', rarity: 0.2 }
    ];
    
    const random = Math.random();
    let cumulative = 0;
    
    for (const prize of prizes) {
        cumulative += prize.rarity;
        if (random <= cumulative) {
            return prize;
        }
    }
    
    return prizes[prizes.length - 1];
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 20px;
        border-radius: 8px;
        color: white;
        font-weight: 500;
        z-index: 10000;
        animation: slideIn 0.3s ease-out;
    `;
    
    if (type === 'success') {
        notification.style.backgroundColor = '#4CAF50';
    } else if (type === 'error') {
        notification.style.backgroundColor = '#f44336';
    } else {
        notification.style.backgroundColor = '#2196F3';
    }
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}

// Initialize the app
document.addEventListener('DOMContentLoaded', function() {
    console.log('App initializing...');
    
    // Initialize TON Connect
    setTimeout(() => {
        initTonConnect();
    }, 100);

    // Set initial tab
    switchTab('home');
    
    // Initialize balance display
    updateBalanceDisplay();

    // Initialize Telegram WebApp
    if (window.Telegram && window.Telegram.WebApp) {
        console.log('Telegram WebApp detected');
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
        
        // Set theme
        if (window.Telegram.WebApp.themeParams) {
            document.documentElement.style.setProperty('--tg-theme-bg-color', window.Telegram.WebApp.themeParams.bg_color);
            document.documentElement.style.setProperty('--tg-theme-text-color', window.Telegram.WebApp.themeParams.text_color);
        }
    }
    
    // Add event listeners for modal closing
    document.addEventListener('click', function(e) {
        const caseModal = document.getElementById('case-modal');
        const depositModal = document.getElementById('deposit-modal');
        
        if (e.target === caseModal) {
            closeCaseModal();
        }
        
        if (e.target === depositModal) {
            closeDepositModal();
        }
    });
    
    console.log('App initialized successfully');
});
