const Candle = require('../models/Candle');
const DailySummary = require('../models/DailySummary');

/**
 * Render the strategy form page
 */
exports.getStrategyForm = (req, res) => {
  res.render('strategy', { 
    title: 'Breakout Strategy Backtest',
    error: null,
    success: null,
    results: null
  });
};

/**
 * Get trading days (dates that have candles) within the date range
 */
async function getTradingDays(securityId, startDate, endDate) {
  const candles = await Candle.find({
    securityId,
    interval: '1',
    timestamp: {
      $gte: startDate,
      $lte: endDate
    }
  }).select('timestamp').lean();

  const dateSet = new Set();
  candles.forEach(candle => {
    const date = new Date(candle.timestamp);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    dateSet.add(dateKey);
  });

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
  const prevDate = new Date(currentDate);
  prevDate.setDate(prevDate.getDate() - 1);

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
    if (candle.high >= target) {
      return { exited: true, exitPrice: target, reason: 'TARGET' };
    }
    if (candle.low <= stopLoss) {
      return { exited: true, exitPrice: stopLoss, reason: 'STOP_LOSS' };
    }
  } else {
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
 * Returns: { trades: [], updatedCapital: number }
 */
function processTradingDay(candles, previousDayLevels, targetPercent, stopLossPercent, currentCapital) {
  if (!previousDayLevels || candles.length === 0) {
    return { trades: [], updatedCapital: currentCapital };
  }

  // Convert percentages to decimals (e.g., 0.2 -> 0.002)
  const targetPercentDecimal = targetPercent / 100;
  const stopLossPercentDecimal = stopLossPercent / 100;

  const { dailyHigh, dailyLow } = previousDayLevels;
  let activeTrade = null;
  let tradeExecuted = false; // Flag to ensure only one trade per day
  const trades = [];
  let updatedCapital = currentCapital;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Only check for new trades if no trade has been executed yet today
    if (!activeTrade && !tradeExecuted) {
      if (candle.high > dailyHigh) {
        const entryPrice = dailyHigh;
        const target = entryPrice * (1 + targetPercentDecimal);
        const stopLoss = entryPrice * (1 - stopLossPercentDecimal);

        // Calculate quantity based on current capital
        const quantity = Math.floor(updatedCapital / entryPrice);
        
        activeTrade = {
          type: 'BUY',
          entryPrice,
          entryTime: candle.timestamp,
          entryCandleIndex: i,
          target,
          stopLoss,
          isBuy: true,
          quantity: quantity
        };
      } else if (candle.low < dailyLow) {
        const entryPrice = dailyLow;
        const target = entryPrice * (1 - targetPercentDecimal);
        const stopLoss = entryPrice * (1 + stopLossPercentDecimal);

        // Calculate quantity based on current capital
        const quantity = Math.floor(updatedCapital / entryPrice);

        activeTrade = {
          type: 'SELL',
          entryPrice,
          entryTime: candle.timestamp,
          entryCandleIndex: i,
          target,
          stopLoss,
          isBuy: false,
          quantity: quantity
        };
      }
    }

    if (activeTrade) {
      const exitCheck = checkExitCondition(
        candle,
        activeTrade.entryPrice,
        activeTrade.isBuy,
        activeTrade.target,
        activeTrade.stopLoss
      );

      if (exitCheck.exited) {
        // Calculate P&L based on quantity
        let pnl, pnlPercent;
        if (activeTrade.isBuy) {
          pnl = (exitCheck.exitPrice - activeTrade.entryPrice) * activeTrade.quantity;
          pnlPercent = ((exitCheck.exitPrice - activeTrade.entryPrice) / activeTrade.entryPrice) * 100;
        } else {
          pnl = (activeTrade.entryPrice - exitCheck.exitPrice) * activeTrade.quantity;
          pnlPercent = ((activeTrade.entryPrice - exitCheck.exitPrice) / activeTrade.entryPrice) * 100;
        }

        // Update capital after trade
        updatedCapital = updatedCapital + pnl;

        trades.push({
          date: new Date(candle.timestamp),
          type: activeTrade.type,
          entryPrice: activeTrade.entryPrice,
          entryTime: activeTrade.entryTime,
          exitPrice: exitCheck.exitPrice,
          exitTime: candle.timestamp,
          exitReason: exitCheck.reason,
          quantity: activeTrade.quantity,
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

    // Calculate P&L based on quantity
    let pnl, pnlPercent;
    if (activeTrade.isBuy) {
      pnl = (exitPrice - activeTrade.entryPrice) * activeTrade.quantity;
      pnlPercent = ((exitPrice - activeTrade.entryPrice) / activeTrade.entryPrice) * 100;
    } else {
      pnl = (activeTrade.entryPrice - exitPrice) * activeTrade.quantity;
      pnlPercent = ((activeTrade.entryPrice - exitPrice) / activeTrade.entryPrice) * 100;
    }

    // Update capital after trade
    updatedCapital = updatedCapital + pnl;

    trades.push({
      date: new Date(lastCandle.timestamp),
      type: activeTrade.type,
      entryPrice: activeTrade.entryPrice,
      entryTime: activeTrade.entryTime,
      exitPrice: exitPrice,
      exitTime: lastCandle.timestamp,
      exitReason: 'END_OF_DAY',
      quantity: activeTrade.quantity,
      pnl: parseFloat(pnl.toFixed(2)),
      pnlPercent: parseFloat(pnlPercent.toFixed(2))
    });
  }

  return { trades, updatedCapital };
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

  const bestTrade = allTrades.reduce((best, current) => 
    current.pnl > best.pnl ? current : best
  );
  const worstTrade = allTrades.reduce((worst, current) => 
    current.pnl < worst.pnl ? current : worst
  );

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
 * Run breakout strategy backtest
 */
exports.runStrategy = async (req, res) => {
  try {
    const { stockName, securityId, startDate, endDate, targetPercent, stopLossPercent, capital } = req.body;

    // Validation
    if (!stockName || !securityId || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Validate and set default values for target and stop loss percentages
    const targetPercentValue = targetPercent !== undefined && targetPercent !== null 
      ? parseFloat(targetPercent) 
      : 0.2; // Default 0.2%
    const stopLossPercentValue = stopLossPercent !== undefined && stopLossPercent !== null 
      ? parseFloat(stopLossPercent) 
      : 0.2; // Default 0.2%

    if (isNaN(targetPercentValue) || targetPercentValue <= 0 || targetPercentValue > 10) {
      return res.status(400).json({
        success: false,
        message: 'Target percent must be a number between 0.01 and 10'
      });
    }

    if (isNaN(stopLossPercentValue) || stopLossPercentValue <= 0 || stopLossPercentValue > 10) {
      return res.status(400).json({
        success: false,
        message: 'Stop loss percent must be a number between 0.01 and 10'
      });
    }

    // Validate and set default value for capital
    const capitalValue = capital !== undefined && capital !== null 
      ? parseFloat(capital) 
      : 100000; // Default ₹1,00,000

    if (isNaN(capitalValue) || capitalValue < 1000) {
      return res.status(400).json({
        success: false,
        message: 'Capital must be a number greater than or equal to 1000'
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format'
      });
    }

    if (start >= end) {
      return res.status(400).json({
        success: false,
        message: 'End date must be after start date'
      });
    }

    // Get trading days
    const tradingDays = await getTradingDays(securityId, start, end);

    if (tradingDays.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No trading days found. Please ensure you have 1-minute candle data in the database.'
      });
    }

    // Process each trading day with capital compounding
    const allTrades = [];
    const skippedDays = [];
    let currentCapital = capitalValue; // Start with initial capital

    for (let i = 0; i < tradingDays.length; i++) {
      const tradingDay = tradingDays[i];

      const previousDayLevels = await getPreviousDayLevels(securityId, tradingDay);
      
      if (!previousDayLevels) {
        skippedDays.push(tradingDay.toISOString().split('T')[0]);
        continue;
      }

      const candles = await getCandlesForDay(securityId, tradingDay);
      
      if (candles.length === 0) {
        skippedDays.push(tradingDay.toISOString().split('T')[0]);
        continue;
      }

      // Process trading day with current capital
      const result = processTradingDay(candles, previousDayLevels, targetPercentValue, stopLossPercentValue, currentCapital);
      
      if (result.trades && result.trades.length > 0) {
        allTrades.push(...result.trades);
        // Update capital after trades (capital compounds)
        currentCapital = result.updatedCapital;
      }
    }

    // Calculate performance metrics
    const metrics = calculatePerformanceMetrics(allTrades);

    // Format trades for response (convert dates to ISO strings)
    const formattedTrades = allTrades.map(trade => ({
      ...trade,
      date: new Date(trade.date).toISOString().split('T')[0],
      entryTime: new Date(trade.entryTime).toISOString(),
      exitTime: new Date(trade.exitTime).toISOString()
    }));

    // Format best/worst trades
    let formattedBestTrade = null;
    let formattedWorstTrade = null;

    if (metrics.bestTrade) {
      formattedBestTrade = {
        ...metrics.bestTrade,
        date: new Date(metrics.bestTrade.date).toISOString().split('T')[0],
        entryTime: new Date(metrics.bestTrade.entryTime).toISOString(),
        exitTime: new Date(metrics.bestTrade.exitTime).toISOString()
      };
    }

    if (metrics.worstTrade) {
      formattedWorstTrade = {
        ...metrics.worstTrade,
        date: new Date(metrics.worstTrade.date).toISOString().split('T')[0],
        entryTime: new Date(metrics.worstTrade.entryTime).toISOString(),
        exitTime: new Date(metrics.worstTrade.exitTime).toISOString()
      };
    }

    res.json({
      success: true,
      config: {
        stockName,
        securityId,
        startDate: start.toISOString().split('T')[0],
        endDate: end.toISOString().split('T')[0],
        targetPercent: targetPercentValue,
        stopLossPercent: stopLossPercentValue,
        capital: capitalValue
      },
      summary: {
        totalTradingDays: tradingDays.length,
        skippedDays: skippedDays.length,
        ...metrics,
        bestTrade: formattedBestTrade,
        worstTrade: formattedWorstTrade
      },
      trades: formattedTrades
    });

  } catch (error) {
    console.error('Error running strategy:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    });
  }
};

