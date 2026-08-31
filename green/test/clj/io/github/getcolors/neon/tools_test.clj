(ns io.github.getcolors.neon.tools-test
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.neon.tools :as tools]
            [io.github.getcolors.neon.validate-test :refer [fixture optout]]))

(defn- spec-for [opts file]
  (some #(when (str/ends-with? (str (:target %)) file) %) (tools/ansible-specs opts)))

(deftest firewall-sources-parse
  (let [data (tools/infrastructure-data (fixture))]
    (is (= ["0.0.0.0/0" "::/0"] (tools/cidrs data :vultr-ssh-sources)))))

(deftest infrastructure-data-carries-the-ssh-mode
  (is (true? (:ssh-keygen (tools/infrastructure-data (fixture)))))
  (is (false? (:ssh-keygen (tools/infrastructure-data (optout))))))

(deftest infrastructure-data-resolves-the-compute-name
  ;; Compute Name Standard §3: every label derives from the one resolved name.
  (is (= "neon-fixture" (:compute-name (tools/infrastructure-data (fixture))))))

(deftest the-r2-prefix-is-namespaced-by-profile
  ;; Two deployments sharing a bucket must never share a prefix: the profile
  ;; is the namespace, and the tofu state at <profile>/<stage>.tfstate is a
  ;; sibling key space that never collides with <profile>/data/.
  (is (= "neon-fixture/data" (tools/r2-prefix (fixture)))))

(deftest inventory-keeps-one-target
  (let [inventory (tools/inventory (assoc (fixture) :ip "192.0.2.10"))]
    (is (str/includes? inventory "192.0.2.10"))
    (is (str/includes? inventory "neon-fixture"))))

(deftest ansible-renders-the-whole-stack
  (let [targets (map #(str (:target %)) (tools/ansible-specs (fixture)))]
    (doseq [f ["ansible.cfg" "main.yml" "cleanup.yml" "compose.yml"
               "pageserver.toml" "identity.toml" "config.json" "scramgen.py"
               "bootstrap.sh" "smoke.sh" "status.sh" "rotate.sh"
               "inventory.json"]]
      (is (some #(str/ends-with? % f) targets) f))))

(deftest operator-secrets-reach-the-host-as-lookups-not-values
  ;; `.colors/` is generated output and the goldens are committed, so the
  ;; secret must never be the thing that lands on disk — the expression is.
  ;; The lookups live literally in the template rather than in the data map,
  ;; because Selmer HTML-escapes a value it interpolates and Ansible would
  ;; receive `&#39;` instead of a quote.
  (let [template (slurp (io/resource "io/github/getcolors/neon/tools/ansible/main.yml"))]
    (doseq [par ["COLORS_PAR_NEON_R2_ACCESS_KEY_ID"
                 "COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? template (str "lookup('env','" par "')")) par))))

(deftest the-data-map-carries-no-operator-secret
  (let [data (:data (spec-for (fixture) "main.yml"))]
    (is (= "neon-fixture/data" (:neon-r2-prefix data)))
    (doseq [k [:neon-r2-access-key-id :neon-r2-secret-access-key]]
      (is (nil? (get data k)) (str k)))))

(deftest the-spec-template-carries-verifier-placeholders-not-values
  ;; The role verifiers are generated on the host and injected there; the
  ;; rendered spec in .colors/ must carry only the placeholders.
  (let [template (slurp (io/resource "io/github/getcolors/neon/tools/ansible/config.json"))]
    (doseq [placeholder ["@CLOUD_ADMIN_VERIFIER@" "@NEON_ROLE_VERIFIER@"
                         "@JWKS_KID@" "@JWKS_X@"]]
      (is (str/includes? template placeholder) placeholder))))

(deftest a-delete-without-compute-skips-the-host-entirely
  ;; There is no machine to stop, and the cleanup play would only fail against
  ;; the placeholder address.
  (is (= 0 (:green/exit (tools/ansible-step (assoc (fixture) :green/event :delete))))))

(deftest acceptance-is-skipped-outside-a-real-create
  (doseq [event [:build :delete]]
    (is (= 0 (:green/exit (tools/acceptance-step (assoc (fixture) :green/event event)))))))
