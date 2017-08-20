'use strict';
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const pgp = require('pg-promise')({});

const BucketName = process.env.BUCKET_NAME;

exports.store_batch = (event, context, callback) => {
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

  var strEvent = JSON.stringify(event);
  var blen = event.body.length;
  var params = { Bucket: BucketName, Key: batchId, Body: event.body };

  s3.putObject(params).promise()
    .then((data) => {
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

function send_error(err, callback) {
  callback(err.error, {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(err)
  });
}

const pgCfg = {
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE
};
const eventCols = [
  'event_id', 'timestamp', 'type', 'bounce_class', 'campaign_id', 'friendly_from', 'message_id',
  'reason', 'rcpt_to', 'subaccount_id', 'template_id', 'transmission_id', 'event'
];
const dupeBatchError = "duplicate key value violates unique constraint \"batches_pkey\"";

exports.process_batch = (event, context, callback) => {
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

  const bucketName = e.s3.bucket.name;
  const objKey = e.s3.object.key;
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

  const params = { Bucket: bucketName, Key: objKey };

  s3.getObject(params).promise().then((data) => {
    const dbh = pgp(pgCfg);
    dbh.tx((t) => {
      return t.none('INSERT INTO public.batches (batch_uuid) VALUES ($1::uuid)', [objKey])
      .then(() => {
        // Delay building this potentially large query string
        // until after we know this batch hasn't already been loaded.
        const colSet = pgp.helpers.ColumnSet(eventCols, {table: 'events'});
        const jsonString = data.Body.toString(); // buffer => string
        const json = JSON.parse(jsonString); // string => object
        // Build query params
        var values = [];
        for (var i = 0; i < json.length; i++) {
          var j = json[i].msys;
          for (var key in j) { j = j[key]; }
          var row = {};
          for (var idx = 0; idx < eventCols.length; idx++) {
            row[eventCols[idx]] = j[eventCols[idx]];
          }
          row.event = JSON.stringify(j);
          values.push(row);
        }
        // Build one query to insert all rows
        const query = pgp.helpers.insert(values, colSet);
        return t.none(query);
      })

    }).then(() => {
      pgp.end();
      callback(null, {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: "processed batch "+ objKey })
      });
      calledBack = true;
      //// delete from s3 after successful processing
      //s3.deleteObject(params).promise()
      //  .then(() => {
      //    console.log('deleted processed batch: ['+ objKey +']');
      //  });

    }).catch((err) => {
      if (err.errorMessage == dupeBatchError) {
        // delete from s3 on duplicate batch id insert
        s3.deleteObject(params).promise()
          .then(() => {
            console.log('deleted duplicate batch: ['+ objKey +']');
          })
          .catch((err) => {
            console.log('error deleting duplicate batch ['+ objKey +']: '+ err);
          });
        callback(null, {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: "duplicate batch "+ objKey })
        });
      } else {
        console.log(err);
        callback(err);
      }
      calledBack = true;
      pgp.end();
    });
  }).catch((err) => {
    if (calledBack === true) {
      return;
    }
    // S3 error
    console.log(err, err.stack);
    callback(err);
  });
};

