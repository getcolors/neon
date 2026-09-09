(ns io.github.getcolors.neon.tools
  (:require [io.github.getcolors.neon.compute :as compute] [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.neon.ssh-config :as ssh-config]
            [io.github.getcolors.neon.validate :as validate]))

(def infrastructure-tool "neon-infrastructure")
(def ansible-tool "neon-ansible")
(def ansible-local-tool "neon-ansible-local")
(def root "io.github.getcolors.neon.tools")
(def template-opts sc/preserve-jinja-delimiters)

(defn tool-dir [opts tool] (green-cli/stage-dir opts tool {:default-profile "neon"}))
(defn template [path file] (keyword (str root "." path) file))
(defn spec [source target data] {:template source :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))

(defn cidrs [opts k]
  (let [v (get opts k) xs (if (sequential? v) v (str/split (str v) #"[,\s]+"))]
    (->> xs (map (comp str/trim str)) (remove str/blank?) vec)))

(defn credential-env [opts & slots]
  (not-empty
   (into {} (keep (fn [[k env-var]]
                    (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (apply merge (map #(validate/tofu-env opts %) (conj (vec slots) :provider-backend))))))
(defn backend-credential-env [opts] (credential-env opts))

(defn fallback-params [opts]
  {:ip "192.0.2.10" :user "root" :sudoer "root" :name (validate/compute-name opts)})
(defn output-params [result]
  (some-> (get-in result [:tofu/outputs :params]) walk/keywordize-keys))

;; The Neon data prefix inside the R2 bucket. Everything the pageserver and
;; safekeeper write — and the ownership markers guarding adoption — lives
;; under `<profile>/data/`. The tofu state for the same deployment lives at
;; `<profile>/<stage>.tfstate` in the same bucket, a sibling key space that
;; never collides with this one.
(defn r2-prefix [opts] (str (:profile opts) "/data"))

;; ---------------------------------------------------------------- compute

(def infrastructure-step compute/infrastructure-step)

;; ---------------------------------------------------------- ansible (local)

(defn ansible-local-data
  "Only what a `build` genuinely knows. The address, the user and the alias are
  run-time facts and reach the play as extra-vars instead, so the rendered
  playbook carries no IP and is identical on every workstation (SSH Config
  Standard §6)."
  [opts]
  (assoc opts
         :ssh-keygen (if (:colors-compute/key opts) (= "managed" (get-in opts [:colors-compute/key :mode])) (validate/keygen? opts))
         :ssh-config-identity-file (ssh-config/identity-file opts)))

(defn ansible-local-specs [opts]
  (let [dir (tool-dir opts ansible-local-tool) data (ansible-local-data opts)]
    [(spec (template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ansible-local-step
  "Write or remove the `~/.ssh/config` block. The same playbook serves both
  events; `block_state` is what distinguishes them."
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        delete? (= :delete (:green/event opts))]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.ini"
       :playbooks {:create "main.yml" :delete "main.yml"}
       :extra-vars {:host_alias (ssh-config/host-alias opts)
                    :ip (or (:ip opts) (:ip (fallback-params opts)))
                    :user (or (:user opts) "root")
                    :block_state (if delete? "absent" "present")}}
      (ansible-local-specs opts))))

;; ---------------------------------------------------------------- ansible

(defn inventory [opts]
  (json/generate-string
   {:all {:children {:neon {:hosts {(:profile opts)
                                    {:ansible_host (or (:ip opts) "192.0.2.10")
                                     :ansible_user (or (:user opts) "root")}}}}}}
   {:pretty true}))

(defn ansible-data
  "Template values for the Ansible stage.

  Deliberately carries neither operator secret. The R2 pair reaches the host
  as Ansible `lookup('env', ...)` expressions written literally into main.yml,
  where `preserve-jinja-delimiters` passes them through untouched — routing
  them through this map instead would let Selmer HTML-escape the quotes and
  hand Ansible `&#39;`. The secret therefore exists only in the process that
  needs it: not in `.colors/`, not in a golden, not in this map."
  [opts]
  (assoc opts
         :ip (or (:ip opts) "192.0.2.10")
         :ssh-keygen (if (:colors-compute/key opts) (= "managed" (get-in opts [:colors-compute/key :mode])) (validate/keygen? opts))
         :neon-r2-prefix (r2-prefix opts)))

(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool) data (ansible-data opts)]
    [(spec (template "ansible" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible" "main.yml") (str dir "/main.yml") data)
     (spec (template "ansible" "cleanup.yml") (str dir "/cleanup.yml") data)
     (spec (template "ansible" "compose.yml") (str dir "/compose.yml") data)
     (spec (template "ansible" "pageserver.toml") (str dir "/pageserver.toml") data)
     (spec (template "ansible" "identity.toml") (str dir "/identity.toml") data)
     (spec (template "ansible" "config.json") (str dir "/config.json") data)
     (spec (template "ansible" "scramgen.py") (str dir "/scramgen.py") data)
     (spec (template "ansible" "bootstrap.sh") (str dir "/bootstrap.sh") data)
     (spec (template "ansible" "smoke.sh") (str dir "/smoke.sh") data)
     (spec (template "ansible" "status.sh") (str dir "/status.sh") data)
     (spec (template "ansible" "rotate.sh") (str dir "/rotate.sh") data)
     (raw-spec (str dir "/inventory.json") (inventory data))]))

(defn ansible-step [opts]
  (let [dir (tool-dir opts ansible-tool)]
    (if (and (= :delete (:green/event opts)) (or (:neon/already-destroyed opts) (not (:ip opts))))
      ;; No compute in state: there is no host to stop, and the cleanup play
      ;; would only fail against the placeholder address.
      (assoc opts :green/exit 0)
      (ansible/ansible-with-spec opts
        {:dir dir :inventory "inventory.json"
         :playbooks {:create "main.yml" :delete "cleanup.yml"}
         :host-key-checking false :private-key (:ssh-private-key-path opts)}
        (ansible-specs opts)))))

;; ------------------------------------------------------------- acceptance

(defn run-quiet
  "Run `args` with `env` overlaid, returning the result map. Nothing from the
  child is echoed; callers decide what becomes an error message, so a secret
  passed through `env` can never leak into output by default."
  [args env timeout-ms]
  (process/run-with-timeout args (if (seq env) {:extra-env env} {}) timeout-ms))

(defn psql-args
  "A psql invocation with an explicit everything: host, port, role, database,
  and `-w` so a missing password fails instead of prompting. `env -i` clears
  the environment and re-admits only PATH, the password handed over through
  the runner, and a dead PGPASSFILE — so no ambient PG* variable, service
  file, or ~/.pgpass can alter what the probe proves."
  [opts port sql]
  ["bash" "-c"
   (str "exec env -i PATH=\"$PATH\" PGPASSFILE=/dev/null"
        " PGPASSWORD=\"$PGPASSWORD\" psql"
        " 'postgresql://" (:neon-role opts) "@127.0.0.1:" port
        "/" (:neon-database opts) "?connect_timeout=10'"
        " -w -v ON_ERROR_STOP=1 -tAc " (process/posix-quote sql))])

(defn tunnel-args
  "An ssh tunnel through the generated `~/.ssh/config` alias — the supported
  client path, exercised end to end: the alias, the identity file, and the
  forward. `-f` returns once the forward is up; the remote `sleep` bounds its
  lifetime so nothing needs killing on the way out. The bash wrapper exists
  for the streams: the daemonized child inherits stdout/stderr, and a runner
  that waits for the pipes to close would otherwise block until the sleep
  expires — returning exactly when the tunnel dies."
  [opts port]
  ["bash" "-c"
   (str "ssh -f -o ExitOnForwardFailure=yes -o BatchMode=yes"
        (when-let [path (:ssh-private-key-path opts)] (str " -i '" (str/replace (str path) "'" "'\\''") "'"))
        " -L " port ":127.0.0.1:55433 "
        (ssh-config/host-alias opts) " sleep 45 >/dev/null 2>&1")])

(def smoke-sql
  "One deployment-scoped row, updated deterministically: the same statement on
  every converge, so a second create reconciles instead of accumulating."
  (str "INSERT INTO colors_smoke (id, note, at) VALUES (1, 'operator-path', now())"
       " ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note, at = EXCLUDED.at;"
       " SELECT count(*) FROM colors_smoke;"))

(defn read-remote-password
  "The generated application-role password, read over SSH and held only in this
  process. Never merged into opts, never printed."
  [opts]
  (let [r (run-quiet (vec (concat ["ssh" "-o" "BatchMode=yes"] (when-let [path (:ssh-private-key-path opts)] ["-i" path]) [(ssh-config/host-alias opts) "cat" "/etc/neon/secrets/neon_role_password"]))
                     {} 20000)]
    (when (zero? (:exit r)) (str/trim (str (:out r))))))

(defn acceptance-step
  "The operator-path gate, after a real create.

  The server-side gates already ran inside the playbook (health, the SQL
  round-trip, the auth negatives, the R2 object listings). What is checked
  from here is the one thing only this side can check: that an operator on
  this workstation reaches the database through the generated SSH config and
  a tunnel — the supported client path — with the generated password, and
  not without it."
  [opts]
  (if (not= :create (:green/event opts))
    (assoc opts :green/exit 0)
    (let [pw (read-remote-password opts)]
      (if-not (seq pw)
        (assoc opts :green/exit 1
               :green/err "acceptance: could not read the generated role password over ssh")
        (loop [ports (take 3 (repeatedly #(+ 20000 (rand-int 40000))))]
          (if-let [port (first ports)]
            (let [tunnel (run-quiet (tunnel-args opts port) {} 30000)]
              (if-not (zero? (:exit tunnel))
                (recur (rest ports))
                (let [ok (run-quiet (psql-args opts port smoke-sql)
                                    {"PGPASSWORD" pw} 30000)
                      denied (run-quiet (psql-args opts port "SELECT 1;")
                                        {"PGPASSWORD" "not-the-password"} 30000)]
                  (cond
                    (not (zero? (:exit ok)))
                    (assoc opts :green/exit 1
                           :green/err (str "acceptance: the tunnelled smoke round-trip failed: "
                                           (str/trim (str (:err ok)))))

                    ;; psql prints the INSERT command tag before the count;
                    ;; the count is the last line.
                    (not= "1" (last (str/split-lines (str/trim (str (:out ok))))))
                    (assoc opts :green/exit 1
                           :green/err (str "acceptance: colors_smoke should hold exactly one row, got "
                                           (str/trim (str (:out ok)))))

                    (zero? (:exit denied))
                    (assoc opts :green/exit 1
                           :green/err "acceptance: a wrong password was accepted through the tunnel")

                    :else
                    (assoc opts :green/exit 0
                           :neon/acceptance {:tunnel "ok" :smoke-rows "1"
                                             :wrong-password "refused"})))))
            (assoc opts :green/exit 1
                   :green/err "acceptance: no local port could carry the ssh tunnel after three attempts")))))))
