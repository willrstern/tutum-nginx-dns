import fs from "fs"
import { spawnSync } from "child_process"

export default function (host, email, linkDest) {
  //where simp_le should create any keys, certs, etc
  const sourceDest = `/etc/ssl/letsencrypt/${host}`;

  //create sourceDest as necessary
  try {
    fs.accessSync(sourceDest);
  } catch(e) {
    fs.mkdirSync(sourceDest);
  }

  //try to generate cert via simp_le
  let proc = null;
  try {
    proc = spawnSync("/var/simp_le/venv/bin/simp_le", [
      "-d", host,
      "--default_root", "/var/simp_le/webroot",
      "-f", "account_key.json",
      "-f", "full.pem",
      "--email", email
    ], { cwd: sourceDest, stdio: "inherit" });
  } catch(err) {
    console.log("Error calling simp_le:", err, err.stack);

    return false;
  }

  //if cert was created (or already existed), symlink to linkDest and return success!
  if (proc.status != 2) {
    try {
      fs.accessSync(linkDest);
    } catch(e) {
      console.log("Installing automated ssl for", host);
      fs.symlinkSync(`${sourceDest}/full.pem`, linkDest);
    }

    return true;
  }

  return false;
}
