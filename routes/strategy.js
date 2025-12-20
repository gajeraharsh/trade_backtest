const express = require('express');
const router = express.Router();
const strategyController = require('../controllers/strategyController');

/**
 * GET /strategy
 * Render the strategy backtest form page
 */
router.get('/', strategyController.getStrategyForm);

/**
 * POST /strategy/run
 * Run the breakout strategy backtest
 */
router.post('/run', strategyController.runStrategy);

/**
 * GET /strategy/chart
 * Get candle data for a specific trade day
 */
router.get('/chart', strategyController.getTradeDayChart);

module.exports = router;

