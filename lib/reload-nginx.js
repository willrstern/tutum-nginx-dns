import axios from "axios"
import checksum from "checksum"
import fs from "fs"
import { execSync } from "child_process"
import { find, snakeCase, trim } from "lodash"

import nginxTemplate from "./nginx-template"
import { api as dockerCloud } from "./docker-cloud"
import autoSsl from "./auto-ssl"

const { NGINX_LB_NAME: lbName, SLACK_WEBHOOK: slackWebhook } = process.env
const configFileName = process.env.NGINX_CONFIG_FILE || "/etc/nginx/conf.d/default.conf"
const certsPath = process.env.NGINX_CERTS || "/certs"
const containerLimit = process.env.CONTAINER_LIMIT || "25"

let hasDeferredAutoSsl = false;
let activeConfigExists = false;

try {
  fs.mkdirSync(certsPath)
} catch(e) {}

/*
 Sequence of Events
*/
export function reloadNginx() {
  try {
    fs.accessSync(configFileName);
    activeConfigExists = true;
  } catch(e) {
    activeConfigExists = false;
  }

  // list all containers
  dockerCloud(`/api/app/v1/container/?limit=${containerLimit}`)
    .then(fetchFullContainerDetail)
    .then(getContainersToBalance)
    .then(parseServices)
    .then(generateNewConfig)
    .then(deferredAutoSsl)
    .catch(err => console.log("Error:", err, err.stack))
}


/*
Helper Functions
*/

export function fetchFullContainerDetail(allContainers) {
  // Fetch-in-parallel the full resource for each container
  return Promise.all(
    allContainers.objects.map(container => dockerCloud(container.resource_uri))
  )
}

export function getContainersToBalance(allContainers) {
  //find containers that have an NGINX_LB env var that matches my NGINX_LB_NAME value
  return allContainers
    .filter((container) => {
      return container.container_envvars
        .filter(env => env.key === "NGINX_LB" && env.value === lbName)
        .length
    })
    //I only care about running containers
    .filter((container) => container.state === "Running")
}

export function parseServices(services) {
  const configs = []
  //grab config from each service
  services.forEach((container) => {
    const certs = find(container.container_envvars, {key: "NGINX_CERTS"})
    const allCerts = !certs ? [] : certs.value.split(",").map(val => val.split("\\n").join("\n"))
    const port = find(container.container_envvars, {key: "NGINX_PORT"})

    let leEmail = find(container.container_envvars, {key: "NGINX_LE_EMAIL"})
    const autoSslEmail = !leEmail ? false : leEmail.value;

    let skipHosts = find(container.container_envvars, {key: "NGINX_LE_SKIP_HOST"})
    const skipAutoSsl = !skipHosts ? [] : skipHosts.value.split(",")

    //for each virtual host, write a cert file if SSL exists,
    //and return {host, ssl}
    const virtualHosts = find(container.container_envvars, {key: "NGINX_VIRTUAL_HOST"}).value
      .split(",")
      .map((host, i) => {
        let ssl = false

        //if certs exist, write them as files and set ssl to true
        if (allCerts[i] && allCerts[i].length) {
          fs.writeFileSync(`${certsPath}/${host}.crt`, allCerts[i])
          ssl = true
        }

        //allow automatic ssl ONLY if we have an email to associate with
        if (autoSslEmail) {
          //if host has no existing cert AND autossl isnt explicitly skipped...
          if (!ssl && skipAutoSsl.indexOf(host) < 0) {
            //and if active nginx config, trigger automatic ssl
            if (activeConfigExists) {
              ssl = autoSsl(host, autoSslEmail, `${certsPath}/${host}.crt`)
            //or if no active nginx config, defer autossl to next reload
            } else {
              hasDeferredAutoSsl = true;
            }
          }
        }

        return { host: trim(host), upstreamName: snakeCase(host), ssl }
      })
      .forEach((virtualHost) => {
        const { host, ssl, upstreamName } = virtualHost
        //does a config for this host exist yet?
        let config = find(configs, { host })

        //create config for this host if it doesn't exist
        if (!config) {
          config = {
            host,
            ssl,
            upstream: [],
            upstreamName,
          }
          configs.push(config)
        }

        //add this container's ip address to upstream for this host
        config.upstream.push(`${container.private_ip}:${port ? port.value : 80}`)
      })
  })

  console.log(configs.length ? configs : "There are no services to load balance")

  return configs
}

export function generateNewConfig(configs) {
  if (configs.length) {
    const newNginxConf = nginxTemplate.render({ configs })

    //reload nginx if config has changed
    checksum.file(configFileName, (err, sum) => {
      if (sum !== checksum(newNginxConf)) {
        reloadNginxConfig(newNginxConf)
      } else {
        console.log("Nginx config was unchanged");
      }
    });
  }
}

export function deferredAutoSsl() {
  if (hasDeferredAutoSsl) {
    console.log("Running deferred automatic SSL");
    hasDeferredAutoSsl = false;
    reloadNginx();
  }
}

export function reloadNginxConfig(config) {
  fs.writeFileSync(configFileName, config);
  const testCmd = process.env.NGINX_RELOAD === "false" ? "" : "nginx -t";
  const reloadCmd = process.env.NGINX_RELOAD === "false" ? "" : "service nginx reload";
  console.log("Testing new Nginx config...");

  try {
    execSync(testCmd);
    execSync(reloadCmd);
    console.log('Nginx reload successful');
    console.log(config);
  } catch(e) {
    configFailed(config, e);
  }
}

export function configFailed(config, stderr) {
  console.log("Config failed", stderr);
  console.log(config);

  if (slackWebhook) {
    const text = `Nginx (${lbName}) config failed:
*Error:*
\`\`\`${stderr}\`\`\`
*Config:*
\`\`\`${config}\`\`\`
    `

    axios.post(slackWebhook, {text, username: `Nginx ${lbName}`});
  }
}
