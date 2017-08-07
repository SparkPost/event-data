'use strict';
var AWS = require('aws-sdk');
var s3 = new AWS.S3();

const bucketName = process.env.BUCKET_NAME;

exports.store_batch = (event, context, callback) => {
  var strEvent = JSON.stringify(event);
  var batchId = null;
  var err = null;
  if (typeof event.headers === 'undefined') {
    err = { error: "headers not found" };
  } else {
    batchId = event.headers['X-MessageSystems-Batch-ID'];
    if (typeof batchId === 'undefined') {
      err = { error: "batch id not found" };
    }
  }

  if (err !== null) {
    // to return client-visible messages, don't specify an error
    // log it out too so it hits cloudwatch
    console.log(err.error);
    callback(null, {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(err)
    });
    return;
  }

  var blen = event.body.length;
  var params = { Bucket: bucketName, Key: batchId, Body: event.body };

  s3.putObject(params, function(err, data) {
    if (err) {
      console.log(err, err.stack);
      callback(err);
      return;
    }

    console.log(data);
    callback(null, {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: "stored "+ blen +" bytes for batch "+ batchId
      })
    });
  });

};

exports.process_batch = (event, context, callback) => {
  var strEvent = JSON.stringify(event);
  console.log("processing event: "+ strEvent);
};

