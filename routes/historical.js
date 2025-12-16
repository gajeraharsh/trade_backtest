const express = require('express');
const router = express.Router();
const historicalController = require('../controllers/historicalController');

/**
 * GET /historical
 * Render the historical data form page
 */
router.get('/', historicalController.getHistoricalForm);

/**
 * POST /historical/fetch
 * Fetch historical data from Dhan API and store in MongoDB
 */
router.post('/fetch', historicalController.fetchAndStoreHistorical);

module.exports = router;

