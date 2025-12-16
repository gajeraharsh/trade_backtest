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

module.exports = router;

