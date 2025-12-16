require('dotenv').config();
const mongoose = require('mongoose');
const Candle = require('../models/Candle');
const DailySummary = require('../models/DailySummary');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/trade';

// Strategy parameters
const TARGET_PERCENT = 0.002; // 0.2%
const STOP_LOSS_PERCENT = 0.002; // 0.2%

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    startDate: null,
    endDate: null,
    securityId: '2885', // Default Reliance
    stockName: 'RELIANCE'
  };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];

    switch (key) {
      case '--start':
        config.startDate = new Date(value);
        break;
      case '--end':
        config.endDate = new Date(value);
        break;
      case '--securityId':
        config.securityId = value;
        break;
      case '--stockName':
        config.stockName = value;
        break;
    }
  }

  // Validate required arguments
  if (!config.startDate || !config.endDate) {
    console.error('❌ Error: --start and --end dates are required');
    console.error('Usage: node scripts/breakoutStrategy.js --start YYYY-MM-DD --end YYYY-MM-DD [--securityId ID] [--stockName NAME]');
    process.exit(1);
  }

  if (isNaN(config.startDate.getTime()) || isNaN(config.endDate.getTime())) {
    console.error('❌ Error: Invalid date format. Use YYYY-MM-DD');
    process.exit(1);
  }

  if (config.startDate >= config.endDate) {
    console.error('❌ Error: End date must be after start date');
    process.exit(1);
  }

  return config;
}

/**
 * Get trading days (dates that have candles) within the date range
 */
async function getTradingDays(securityId, startDate, endDate) {
  // Get all unique dates from candles
  const candles = await Candle.find({
    securityId,
    interval: '1',
    timestamp: {
      $gte: startDate,
      $lte: endDate
    }
  }).select('timestamp').lean();

  // Extract unique dates
  const dateSet = new Set();
  candles.forEach(candle => {
    const date = new Date(candle.timestamp);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    dateSet.add(dateKey);
  });

  // Convert to sorted array of Date objects
  const tradingDays = Array.from(dateSet)
    .map(dateStr => {
      const [year, month, day] = dateStr.split('-').map(Number);
      return new Date(year, month - 1, day);
    })
    .sort((a, b) => a - b);

  return tradingDays;
}

/**
 * Get previous trading day's high and low
 */
async function getPreviousDayLevels(securityId, currentDate) {
  // Get the date before current date
  const prevDate = new Date(currentDate);
  prevDate.setDate(prevDate.getDate() - 1);

  // Find the most recent daily summary before or on prevDate
  const dailySummary = await DailySummary.findOne({
    securityId,
    date: { $lte: prevDate }
  }).sort({ date: -1 }).lean();

  if (!dailySummary) {
    return null;
  }

  return {
    dailyHigh: dailySummary.dailyHigh,
    dailyLow: dailySummary.dailyLow,
    date: dailySummary.date
  };
}

/**
 * Get all 1-minute candles for a specific trading day
 */
async function getCandlesForDay(securityId, date) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const candles = await Candle.find({
    securityId,
    interval: '1',
    timestamp: {
      $gte: startOfDay,
      $lte: endOfDay
    }
  }).sort({ timestamp: 1 }).lean();

  return candles;
}

/**
 * Check if price touches target or stop loss within candle range
 */
function checkExitCondition(candle, entryPrice, isBuy, target, stopLoss) {
  if (isBuy) {
    // For BUY: target is above entry, stop loss is below entry
    if (candle.high >= target) {
      return { exited: true, exitPrice: target, reason: 'TARGET' };
    }
    if (candle.low <= stopLoss) {
      return { exited: true, exitPrice: stopLoss, reason: 'STOP_LOSS' };
    }
  } else {
    // For SELL: target is below entry, stop loss is above entry
    if (candle.low <= target) {
      return { exited: true, exitPrice: target, reason: 'TARGET' };
    }
    if (candle.high >= stopLoss) {
      return { exited: true, exitPrice: stopLoss, reason: 'STOP_LOSS' };
    }
  }
  return { exited: false };
}

/**
 * Run breakout strategy for a single trading day
 */
function processTradingDay(candles, previousDayLevels) {
  if (!previousDayLevels || candles.length === 0) {
    return null;
  }

  const { dailyHigh, dailyLow } = previousDayLevels;
  let activeTrade = null;
  let tradeExecuted = false; // Flag to ensure only one trade per day
  const trades = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Only check for new trades if no trade has been executed yet today
    if (!activeTrade && !tradeExecuted) {
      // BUY signal: candle high breaks previous day high
      if (candle.high > dailyHigh) {
        const entryPrice = dailyHigh; // Enter at breakout level
        const target = entryPrice * (1 + TARGET_PERCENT);
        const stopLoss = entryPrice * (1 - STOP_LOSS_PERCENT);

        activeTrade = {
          type: 'BUY',
          entryPrice,
          entryTime: candle.timestamp,
          entryCandleIndex: i,
          target,
          stopLoss,
          isBuy: true
        };
      }
      // SELL signal: candle low breaks previous day low
      else if (candle.low < dailyLow) {
        const entryPrice = dailyLow; // Enter at breakout level
        const target = entryPrice * (1 - TARGET_PERCENT); // 0.2% down
        const stopLoss = entryPrice * (1 + STOP_LOSS_PERCENT); // 0.2% up

        activeTrade = {
          type: 'SELL',
          entryPrice,
          entryTime: candle.timestamp,
          entryCandleIndex: i,
          target,
          stopLoss,
          isBuy: false
        };
      }
    }

    // If we have an active trade, check for exit conditions
    if (activeTrade) {
      const exitCheck = checkExitCondition(
        candle,
        activeTrade.entryPrice,
        activeTrade.isBuy,
        activeTrade.target,
        activeTrade.stopLoss
      );

      if (exitCheck.exited) {
        // Calculate P&L
        let pnl, pnlPercent;
        if (activeTrade.isBuy) {
          pnl = exitCheck.exitPrice - activeTrade.entryPrice;
          pnlPercent = (pnl / activeTrade.entryPrice) * 100;
        } else {
          pnl = activeTrade.entryPrice - exitCheck.exitPrice;
          pnlPercent = (pnl / activeTrade.entryPrice) * 100;
        }

        trades.push({
          date: new Date(candle.timestamp),
          type: activeTrade.type,
          entryPrice: activeTrade.entryPrice,
          entryTime: activeTrade.entryTime,
          exitPrice: exitCheck.exitPrice,
          exitTime: candle.timestamp,
          exitReason: exitCheck.reason,
          pnl: parseFloat(pnl.toFixed(2)),
          pnlPercent: parseFloat(pnlPercent.toFixed(2))
        });

        activeTrade = null;
        tradeExecuted = true; // Mark that a trade has been executed today
        break; // Exit loop immediately after first trade is closed
      }
    }
  }

  // If trade is still active at end of day, exit at last candle's close
  // Only if no trade has been executed yet (shouldn't happen due to break, but safety check)
  if (activeTrade && candles.length > 0 && !tradeExecuted) {
    const lastCandle = candles[candles.length - 1];
    const exitPrice = lastCandle.close;

    let pnl, pnlPercent;
    if (activeTrade.isBuy) {
      pnl = exitPrice - activeTrade.entryPrice;
      pnlPercent = (pnl / activeTrade.entryPrice) * 100;
    } else {
      pnl = activeTrade.entryPrice - exitPrice;
      pnlPercent = (pnl / activeTrade.entryPrice) * 100;
    }

    trades.push({
      date: new Date(lastCandle.timestamp),
      type: activeTrade.type,
      entryPrice: activeTrade.entryPrice,
      entryTime: activeTrade.entryTime,
      exitPrice: exitPrice,
      exitTime: lastCandle.timestamp,
      exitReason: 'END_OF_DAY',
      pnl: parseFloat(pnl.toFixed(2)),
      pnlPercent: parseFloat(pnlPercent.toFixed(2))
    });
  }

  return trades;
}

/**
 * Calculate performance metrics
 */
function calculatePerformanceMetrics(allTrades) {
  if (allTrades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnl: 0,
      averagePnl: 0,
      bestTrade: null,
      worstTrade: null,
      maxDrawdown: 0
    };
  }

  const winningTrades = allTrades.filter(t => t.pnl > 0);
  const losingTrades = allTrades.filter(t => t.pnl < 0);
  const totalPnl = allTrades.reduce((sum, t) => sum + t.pnl, 0);
  const averagePnl = totalPnl / allTrades.length;
  const winRate = (winningTrades.length / allTrades.length) * 100;

  // Find best and worst trades
  const bestTrade = allTrades.reduce((best, current) => 
    current.pnl > best.pnl ? current : best
  );
  const worstTrade = allTrades.reduce((worst, current) => 
    current.pnl < worst.pnl ? current : worst
  );

  // Calculate maximum drawdown
  let runningPnl = 0;
  let peak = 0;
  let maxDrawdown = 0;

  allTrades.forEach(trade => {
    runningPnl += trade.pnl;
    if (runningPnl > peak) {
      peak = runningPnl;
    }
    const drawdown = peak - runningPnl;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  });

  return {
    totalTrades: allTrades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: parseFloat(winRate.toFixed(2)),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    averagePnl: parseFloat(averagePnl.toFixed(2)),
    bestTrade,
    worstTrade,
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2))
  };
}

/**
 * Display results to console
 */
function displayResults(config, allTrades, metrics) {
  console.log('\n' + '='.repeat(80));
  console.log('📊 BREAKOUT STRATEGY BACKTEST RESULTS');
  console.log('='.repeat(80));
  
  console.log('\n📋 Strategy Parameters:');
  console.log(`   Stock: ${config.stockName} (${config.securityId})`);
  console.log(`   Date Range: ${config.startDate.toISOString().split('T')[0]} to ${config.endDate.toISOString().split('T')[0]}`);
  console.log(`   Target: +${(TARGET_PERCENT * 100).toFixed(2)}%`);
  console.log(`   Stop Loss: -${(STOP_LOSS_PERCENT * 100).toFixed(2)}%`);
  console.log(`   Max Trades Per Day: 1`);

  console.log('\n📈 Performance Metrics:');
  console.log(`   Total Trades: ${metrics.totalTrades}`);
  console.log(`   Winning Trades: ${metrics.winningTrades}`);
  console.log(`   Losing Trades: ${metrics.losingTrades}`);
  console.log(`   Win Rate: ${metrics.winRate}%`);
  console.log(`   Total P&L: ₹${metrics.totalPnl.toFixed(2)}`);
  console.log(`   Average P&L per Trade: ₹${metrics.averagePnl.toFixed(2)}`);
  console.log(`   Maximum Drawdown: ₹${metrics.maxDrawdown.toFixed(2)}`);

  if (metrics.bestTrade) {
    console.log(`\n   Best Trade:`);
    console.log(`      Type: ${metrics.bestTrade.type}`);
    console.log(`      Entry: ₹${metrics.bestTrade.entryPrice.toFixed(2)} at ${metrics.bestTrade.entryTime}`);
    console.log(`      Exit: ₹${metrics.bestTrade.exitPrice.toFixed(2)} at ${metrics.bestTrade.exitTime}`);
    console.log(`      P&L: ₹${metrics.bestTrade.pnl.toFixed(2)} (${metrics.bestTrade.pnlPercent.toFixed(2)}%)`);
    console.log(`      Exit Reason: ${metrics.bestTrade.exitReason}`);
  }

  if (metrics.worstTrade) {
    console.log(`\n   Worst Trade:`);
    console.log(`      Type: ${metrics.worstTrade.type}`);
    console.log(`      Entry: ₹${metrics.worstTrade.entryPrice.toFixed(2)} at ${metrics.worstTrade.entryTime}`);
    console.log(`      Exit: ₹${metrics.worstTrade.exitPrice.toFixed(2)} at ${metrics.worstTrade.exitTime}`);
    console.log(`      P&L: ₹${metrics.worstTrade.pnl.toFixed(2)} (${metrics.worstTrade.pnlPercent.toFixed(2)}%)`);
    console.log(`      Exit Reason: ${metrics.worstTrade.exitReason}`);
  }

  if (allTrades.length > 0) {
    console.log('\n📝 Trade Details:');
    console.log('-'.repeat(80));
    console.log('Date       | Type | Entry Price | Exit Price | P&L      | P&L %   | Exit Reason');
    console.log('-'.repeat(80));
    
    allTrades.forEach(trade => {
      const dateStr = new Date(trade.date).toISOString().split('T')[0];
      console.log(
        `${dateStr} | ${trade.type.padEnd(4)} | ₹${trade.entryPrice.toFixed(2).padStart(10)} | ₹${trade.exitPrice.toFixed(2).padStart(10)} | ₹${trade.pnl.toFixed(2).padStart(8)} | ${trade.pnlPercent.toFixed(2).padStart(6)}% | ${trade.exitReason}`
      );
    });
    console.log('-'.repeat(80));
  }

  console.log('\n' + '='.repeat(80));
}

/**
 * Main strategy execution function
 */
async function runStrategy() {
  try {
    const config = parseArgs();

    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Get trading days
    console.log(`📅 Finding trading days from ${config.startDate.toISOString().split('T')[0]} to ${config.endDate.toISOString().split('T')[0]}...`);
    const tradingDays = await getTradingDays(config.securityId, config.startDate, config.endDate);
    console.log(`✅ Found ${tradingDays.length} trading days\n`);

    if (tradingDays.length === 0) {
      console.log('⚠️  No trading days found. Please ensure you have 1-minute candle data in the database.');
      await mongoose.disconnect();
      process.exit(0);
    }

    // Process each trading day
    console.log('🔄 Processing trading days...\n');
    const allTrades = [];

    for (let i = 0; i < tradingDays.length; i++) {
      const tradingDay = tradingDays[i];
      const dateStr = tradingDay.toISOString().split('T')[0];

      // Get previous day levels
      const previousDayLevels = await getPreviousDayLevels(config.securityId, tradingDay);
      
      if (!previousDayLevels) {
        console.log(`⚠️  Skipping ${dateStr}: No previous day data available`);
        continue;
      }

      // Get candles for this day
      const candles = await getCandlesForDay(config.securityId, tradingDay);
      
      if (candles.length === 0) {
        console.log(`⚠️  Skipping ${dateStr}: No candles found`);
        continue;
      }

      // Process the day
      const trades = processTradingDay(candles, previousDayLevels);
      
      if (trades && trades.length > 0) {
        allTrades.push(...trades);
        console.log(`✅ ${dateStr}: ${trades.length} trade(s) executed`);
      } else {
        console.log(`ℹ️  ${dateStr}: No trades executed`);
      }
    }

    // Calculate performance metrics
    console.log('\n📊 Calculating performance metrics...');
    const metrics = calculatePerformanceMetrics(allTrades);

    // Display results
    displayResults(config, allTrades, metrics);

    // Disconnect
    await mongoose.disconnect();
    console.log('\n✅ Strategy backtest completed!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error running strategy:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the strategy
runStrategy();

