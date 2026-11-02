# Shopify Sync Actions

![](https://img.shields.io/github/package-json/v/guello/shopify-sync-actions?style=flat)
[![](https://github.com/guello/shopify-sync-actions/actions/workflows/sync-collections.yml/badge.svg)](https://github.com/guello/shopify-sync-actions/actions/workflows/sync-collections.yml)
[![](https://github.com/guello/shopify-sync-actions/actions/workflows/sync-products.yml/badge.svg)](https://github.com/guello/shopify-sync-actions/actions/workflows/sync-products.yml)

Actions to synchronize data between Shopify stores and external services.

## Setup

Download the repository and install the dependencies:

```sh
git clone git@github.com:guello/shopify-sync-actions.git
cd shopify-sync-actions
pnpm install
```

Copy the `.env.example` file to `.env` and fill in the necessary environment variables for the actions you want to run.

## Actions

Run an action with:

```sh
pnpm run action <workflow-name>
```

Each action has a corresponding workflow in the `.github/workflows` that runs every 5 minutes[\*](#run-workflows-in-shorter-intervals) and can be triggered manually from the repository's Actions tab.

### Failure alerts

The [Monitor](.github/workflows/monitor.yml) workflow runs after each completed sync run and flags a sync workflow after consecutive unsuccessful runs; a successful run resets the count. The threshold defaults to 3. To change it, set the repository Actions variable `SYNC_FAILURE_THRESHOLD` to an integer from 1 to 100 under Settings > Secrets and variables > Actions > Variables. Invalid values fail the monitor rather than disabling alerts. Sync job errors remain visible in their run logs, but are tolerated at the job level so a single transient error does not fail the sync workflow. Failures of the monitor workflow trigger GitHub Actions failure notifications when you have enabled them in your GitHub notification settings. Each problem alerts once: the monitor fails only for problems that its previous run did not report, and logs ongoing problems as warnings. A problem that clears and returns alerts again.

The monitor also checks every 15 minutes that each sync workflow has started and completed a run within the last 30 minutes. It fails if a workflow stops starting or its runs stop completing. A manual run of Monitor performs the same checks. If GitHub Actions itself stops running schedules, this check cannot execute; use an independent external heartbeat monitor if missed schedules must be reported even during a GitHub Actions outage.

The Monitor workflow also runs a daily keep-alive job. GitHub disables scheduled workflows in public repositories after 60 days without activity, so the job adds an empty commit when the last commit is more than 50 days old.

### Sync Collections Status

The action synchronizes the publications of a Shopify collection depending on a given metafield and logs the operations in a Google Sheets spreadsheet.

| Workflow                                                     | Environment                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`sync-collections`](.github/workflows/sync-collections.yml) | `GOOGLE_SHEETS_CLIENT_EMAIL`<br>`GOOGLE_SHEETS_PRIVATE_KEY`<br>`GOOGLE_SHEETS_SPREADSHEET_ID`<br>`GOOGLE_SHEETS_SYNC_COLLECTIONS_SHEET`<br>`SHOPIFY_ACCESS_TOKEN`<br>`SHOPIFY_STORE_ID` |

### Sync Products Quantity

The action synchronizes the product quantities stored in a custom system with the quantities of the Shopify store, and logs the operations in a Google Sheets spreadsheet.

| Workflow                                               | Environment                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`sync-products`](.github/workflows/sync-products.yml) | `GOOGLE_SHEETS_CLIENT_EMAIL`<br>`GOOGLE_SHEETS_PRIVATE_KEY`<br>`GOOGLE_SHEETS_SPREADSHEET_ID`<br>`GOOGLE_SHEETS_SYNC_PRODUCTS_SHEET`<br>`PIM_API_URL`<br>`PIM_API_KEY`<br>`PIM_VERIFY_ENDPOINT`<br>`RETRIES` (optional)<br>`SHOPIFY_ACCESS_TOKEN`<br>`SHOPIFY_LOCATION_ID`<br>`SHOPIFY_STORE_ID` |

## Notes

### Run workflows in shorter intervals

GitHub Actions has a limit of 5 minutes for intervals between workflow runs. To run a workflow every minute, the action needs a `repository_dispatch` event, which can be triggered with the following HTTP request:

```sh
curl --request POST \
  --url 'https://api.github.com/repos/<repo>/dispatches' \
  --header 'authorization: Bearer <GITHUB_ACCESS_TOKEN>' \
  --data '{ "event_type": "sync-products" }'
```

A simple service that can send requests every minute is [Google Cloud Scheduler](https://cloud.google.com/scheduler).
