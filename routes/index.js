var express = require('express');
var fs = require('fs');
var router = express.Router();
var downloads = require('../downloads');

/* GET home page. */
router.get('/', function (req, res) {
  res.render('index', { title: 'ReoClone — Clone any website in seconds' });
});

/* One-time zip download. The file lives only in temp and is deleted the
   moment the download finishes, so nothing is stored on the server. */
router.get('/download/:id', function (req, res) {
  var entry = downloads.get(req.params.id);
  if (!entry) {
    return res.status(404).send('This download has expired or was already used.');
  }

  res.download(entry.zipPath, entry.filename, function (err) {
    // Remove the zip whether the download succeeded or failed.
    downloads.remove(req.params.id);
    if (err && !res.headersSent) {
      res.status(500).end();
    }
  });
});

module.exports = router;
