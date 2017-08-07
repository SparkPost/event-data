'use strict';
var AWS = require('aws-sdk');
var s3 = new AWS.S3();

const BucketName = process.env.BUCKET_NAME;

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
  var params = { Bucket: BucketName, Key: batchId, Body: event.body };

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
  var err = null;

  // DEBUG
  var strEvent = JSON.stringify(event);
  console.log("processing event: "+ strEvent);

  if (typeof event.Records === 'undefined') {
    err = { error: "event.Records not found" };
  } else if (event.Records.length != 1) {
    err = { error: "expected 1 record, got ["+ event.Records.length +"]" };
  }
  var e = event.Records[0];
  if (e.eventSource !== "aws:s3") {
    err = { error: "unexpected event source ["+ e.eventSource +"]" }
  }
  var bucketName = e.s3.bucket.name;
  var objKey = e.s3.object.key;
  if (typeof bucketName === 'undefined') {
    err = { error: "no bucket name in event" };
  } else if (bucketName !== BucketName) {
    err = { error: "unexpected bucket name ["+ bucketName +"]" };
  } else if (typeof objKey === 'undefined') {
    err = { error: "no object key in event" };
  }

  if (err !== null) {
    callback(err.error, {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(err)
    });
    return;
  }

  var params = { Bucket: bucketName, Key: objKey };
  s3.getObject(params, _process_batch);
};

function _process_batch(err, data) {
  if (err) {
    console.log(err, err.stack);
    callback(err);
    return;
  }

  console.log(data);
}
