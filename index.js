'use strict';
//var AWS = require('aws-sdk');


const bucketName = process.env.BUCKET_NAME;

exports.store_batch = (event, context, callback) => {
  //var s3 = new AWS.S3();
  console.log("would store batch to "+ bucketName);
  context.succeed({ statusCode: 200, body: "{\"foo\": \"would store batch to "+ bucketName +"\"}" });
  return { statusCode: 200, body: "{\"foo\": \"would store batch to "+ bucketName +"\"}" };
}
