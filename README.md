# Event Data

## What is this?

An example application that is (almost) a drop-in replacement for the Message Events interface.
It lets you configure your own data retention period, add custom filters, and optimize for your most common queries.
All of the system components are eligible for the AWS free tier, so this system will be no- or low-cost to operate.

One important note about this system is that it allows anyone who knows the url to see your event data, including email addresses.
Here are the [official docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html) on setting up an IP Whitelist for API Gateway, and [another post](http://benfoster.io/blog/aws-api-gateway-ip-restrictions) that covers how to use [Postman](https://getpostman.com) to sign and submit requests.

[Message Events](https://developers.sparkpost.com/api/message-events.html) returns JSON that looks like:

    {
      "links": [],
      "results": [],
      "total_count": 0
    }

This system returns an array of events, the `results` value from above.

## How do I use it?

The majority of the system is described in [this CloudFormation template](./event-data.yaml).
Some of the setup steps require using the AWS Console (webui) or the `aws` command line tool.
For starters, you'll need [an AWS account](https://aws.amazon.com/).

### RDS Setup

Once you're signed into your shiny new account, select [RDS](https://us-west-2.console.aws.amazon.com/rds/), then `Launch a DB Instance`.
Click the `Free tier eligible only` checkbox, and click on the PostgreSQL elephant, then the `Select` button.
Change `Allocated Storage` to `20GB`, which was the maximum amount of free tier storage allowed as of this writing.
Choose a `DB Instance Identifier` (nickname), and `Username` / `Password` you'll use later to connect, then click `Next Step`.
After saving the password in your favorite [password](https://1password.com/) [management](https://www.lastpass.com/) [tool](http://keepass.info/), of course.
Defaults are mostly good on this screen (`Configure Advanced Settings`) except for `Database Name`, which can be the same as your `Instance Identifier` / nickname.
When you're ready, click `Launch DB Instance` to set the wheels in motion. It'll probably take a few minutes to launch.

### CLI and S3

To continue feeling productive, you can install and configure the `aws` CLI, which is covered in great detail [here](https://github.com/aws/aws-cli#readme).

Once that's all [configured](https://github.com/aws/aws-cli#user-content-getting-started), let's do the next manual step:
make an S3 bucket that our Lambda functions can call home.

    $ aws s3 mb s3://best-lambdas-evar

### RDS Setup, Part Deux

Hooray, we have a database!
But we have a blank database.
And we can't connect to our blank database.
Let's fix that last bit first by adding a rule that allows our IP to connect: `Services > VPC > Security Groups > (select yours)`.
Here's two quick ways to get your IP:

    $ dig +short myip.opendns.com @resolver1.opendns.com
    $ dig +short txt o-o.myaddr.l.google.com @ns1.google.com

Click the `Inbound Rules` tab at the bottom, then `Edit` and `Add another rule`.
Enter `5432` in the `Port Range` column, and your IP in the `Source` column and click `Save`.
Now we can at least connect to our database using [`psql`](https://www.postgresql.org/docs/current/static/app-psql.html).
Which we will not do now. Yet.

### Environment Variables

Gathering all of this information is one of the big reasons I'd like to manage the RDS setup with CloudFormation, since then the majority of these can be references internal to the CF template. What I've done to make this easier on myself is to keep all this information in my password manager so I can do a quick copy/paste to set all the required env vars.

#### CloudFormation Stuff

`CF_STACK_NAME` - pick a name for your "stack" (group of things CF creates)

#### S3 Stuff

`LAMBDA_S3_BUCKET` - this is the name of the bucket we created in `CLI and S3`

`WEBHOOKS_S3_BUCKET` - name of bucket to be created by CloudFormation

#### RDS Stuff

`PGHOST` - hostname of RDS database (`Services > RDS > DB Instances > (expand row) > Endpoint`)

`PGDB` - `nickname` from the `RDS Setup` section

`PGUSER` - `Username` from the `RDS Setup` section

`PGPASS` - `Password` from the `RDS Setup` section

#### VPC Stuff

If you have more than one VPC, you AWS pro, make a note of which one your RDS instance runs in.
Click `Services > VPC`, click `VPC` again to bring up a listing, select the VPC that has your RDS instance.

`RDS_VPC_ID` - `VPC ID` column value

`RDS_RTB_ID` - `Route table` column value

In the far left menu, `Your VPCs` will be selected, click `Subnets`.

`RDS_SN` - comma-separated list of `Subnet ID` column values for RDS VPC

    RDS_SN=subnet-f0000000,subnet-d0000000,subnet-b0000000

Again in the far left menu, click `Security Groups`

`RDS_SG` - `Group ID` column value, for RDS VPC

### RDS Setup, Part Trois

Since we have our handy env vars filled with PostgreSQL connection info, let's create our tables:

    $ psql -h $PGHOST -U $PGUSER -d $PGDB
    Password for user msgevents:
    psql (9.6.1, server 9.6.2)
    SSL connection (protocol: TLSv1.2, cipher: ECDHE-RSA-AES256-GCM-SHA384, bits: 256, compression: off)
    msgevents=> \i ./sql/tables.ddl

and load in the auto-partitioning code:

    msgevents=> \i ./sql/auto-partitioner.sql

and voila, our database is ready to accept event data.

### CloudFormation

AKA the go button(s) for all the not-database stuff.
This repo contains two scripts, `package` and `deploy`, corresponding to the `aws cloudformation` CLI commands.
If you'd like some more insight into what they're doing, [this blog post](https://aws.amazon.com/blogs/compute/introducing-simplified-serverless-application-deplyoment-and-management/) gives an overview.
For even more detail, read through and cross-reference with `aws cloudformation package help` / `aws cloudformation deploy help`.

Basically, `package` gets everything ready to go.
It uploads your Lambda code to the specified S3 bucket and generates another CloudFormation template referencing that.

    $ ./package
    Uploading to 8774ed690767d127efd4345b71235945  559845 / 559845.0  (100.00%)
    Successfully packaged artifacts and wrote output template to file event-data.cf.yaml.
    Execute the following command to deploy the packaged template
    aws cloudformation deploy --template-file ./event-data.cf.yaml --stack-name <YOUR STACK NAME>

Once that's done, we can `deploy`.

    $ ./deploy
    Waiting for changeset to be created..
    Waiting for stack create/update to complete
    Successfully created/updated stack - <YOUR STACK NAME>


## How do I test it?

SparkPost's webhook config page lets us send test payloads to sanity check our setup, so let's do that.
First we need the URL of our endpoint: `Services > API Gateway > <YOUR STACK NAME> > Stages > Prod > Invoke URL`.
Also, we need to append the correct `Resource` path, which in this case is `/store_batch`.
That should end up looking something like:

    https://0123456789.execute-api.us-west-2.amazonaws.com/Prod/store_batch

Log in to your SparkPost account and click `Account > Webhooks > New Webhook`.
Pick any `Webhook Name` you like, use the url we found above as the `Target URL`, and `Add Webhook`.
To send a batch of test data, click the aptly-named `Test` link, then scroll down and click `Send Test Batch`.
The batch will be sent, and the UI will display the server's response.
Now remember we're only storing the batch in-band, so there are a couple places we can look for info on what happened.

The first place is CloudWatch: `Services > CloudWatch > Logs`.
There will be a few `Log Groups` there.
The one containing `StoreBatch` isn't very interesting, it shows things we can also see by looking at `ProcessBatch`, so let's click through into that one.
We can see a message containing `deleted processed batch`, and a batch UUID, which means success.

To search through the test data we've just loaded, let's use the `query_events` endpoint. When querying the test data, you'll need to specify `from` and `to`, since the test data is dated `2016-02-02`, and the default time window is the last 24 hours.

    $ curl https://0123456789.execute-api.us-west-2.amazonaws.com/Prod/query_events\?type\=open\&from\=2016-02-02T00:00:00Z\&to\=2016-02-03T00:00:00Z

Which will hand back a JSON-encoded array of matching events.
If you're handy with `psql`, you can also connect directly and examine the `batches` and `events` tables.
The `events` data is [partitioned](https://www.postgresql.org/docs/current/static/ddl-partitioning.html) by month in this setup, which makes it super easy to do things like archive data a month at a time, and lets the query planner scan only the relevant months.

### That's all folks!
