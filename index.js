'use strict';
var AWS = require('aws-sdk');
var s3 = new AWS.S3();
var pg = require('pg');

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

  s3.putObject(params).promise()
    .then((data) => {
      console.log(data);
      callback(null, {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: "stored "+ blen +" bytes for batch "+ batchId
        })
      });
    })
    .catch((err) => {
      console.log(err, err.stack);
      callback(err);
    });
};

const PGHost = process.env.PG_HOST;
const PGUser = process.env.PG_USER;
const PGPass = process.env.PG_PASS;
const PGDB   = process.env.PG_DB;

var PGDSN  = 'postgres://'+ PGUser +':'+ PGPass +'@'+ PGHost +'/'+ PGDB;

function send_error(err, callback) {
  callback(err.error, {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(err)
  });
}

exports.process_batch = (event, context, callback) => {
  var err = null;

  // DEBUG
  var strEvent = JSON.stringify(event);
  console.log("processing event: "+ strEvent);

  if (typeof event.Records === 'undefined') {
    send_error({ error: "event.Records not found" });
    return;
  } else if (event.Records.length !== 1) {
    send_error({ error: "expected 1 record, got ["+ event.Records.length +"]" });
    return;
  }

  var e = event.Records[0];
  if (e.eventSource !== "aws:s3") {
    send_error({ error: "unexpected event source ["+ e.eventSource +"]" });
    return;
  }

  var bucketName = e.s3.bucket.name;
  var objKey = e.s3.object.key;
  if (typeof bucketName === 'undefined') {
    send_error({ error: "no bucket name in event" });
    return;
  } else if (bucketName !== BucketName) {
    send_error({ error: "unexpected bucket name ["+ bucketName +"]" });
    return;
  } else if (typeof objKey === 'undefined') {
    send_error({ error: "no object key in event" });
    return;
  }

  var params = { Bucket: bucketName, Key: objKey };
  console.log('will connect to ['+ PGDSN +']');
  var dbh = new pg.Client(PGDSN);

  s3.getObject(params).promise()
    .then(function(data) {
      console.log('connecting to postgres'); // DEBUG
      dbh.connect();
      // Make sure we have a live connection by running a dummy query
      dbh.query('SELECT now() as now')
        .then((res) => {
          console.log(res);
          callback(null, {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(res)
          });
        }).catch((err) => {
          console.log(err);
          callback(err);
        }).then(() => {
          dbh.end();
        });
  }).catch(function(err) {
    console.log(err, err.stack);
    callback(err);
  });
};

