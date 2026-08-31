(ns io.github.getcolors.neon.workflow-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.neon.validate-test :refer [fixture]]
            [io.github.getcolors.neon.workflow :as workflow]))

(deftest build-and-dry-run-need-no-credentials
  (is (= 0 (:green/exit (workflow/start-step (assoc (fixture) :green/event :build) {}))))
  (is (= 0 (:green/exit (workflow/start-step
                         (assoc (fixture) :green/event :create :green/dry-run true) {})))))

(deftest build-and-dry-run-never-touch-ssh
  ;; The standard forbids reading, creating, or requiring anything under ~/.ssh
  ;; on a build or dry-run: they render from desired state alone.
  (doseq [opts [(assoc (fixture) :green/event :build)
                (assoc (fixture) :green/event :create :green/dry-run true)]]
    (let [result (workflow/start-step opts {})]
      (is (= 0 (:green/exit result)))
      (is (str/starts-with? (str (:ssh-public-key-path result)) "/home/build-placeholder")
          "a build must not name the operator's home directory"))))

(deftest real-create-requires-credentials
  (let [r (workflow/start-step (assoc (fixture) :green/event :create) {})]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COLORS_PAR_VULTR_API_KEY"))
    (is (str/includes? (:green/err r) "COLORS_PAR_NEON_R2_ACCESS_KEY_ID"))
    ;; No DNS provider in this package: nothing is reachable by name, so no
    ;; Cloudflare token may be demanded.
    (is (not (str/includes? (:green/err r) "CLOUDFLARE")))))

(deftest delete-is-protected
  (let [r (workflow/start-step (assoc (fixture) :green/event :delete) {})]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COMPUTE_PREVENT_DESTROY"))))

(deftest graph-orders-the-stack
  (is (= [:neon/infrastructure]
         (vec (rest (workflow/wire-fn :neon/start {:green/event :create})))))
  ;; The ssh-config block goes before the converge: both the converge and the
  ;; acceptance ride the alias it writes.
  (is (= [:neon/ssh-config]
         (vec (rest (workflow/wire-fn :neon/infrastructure {:green/event :create})))))
  (is (= [:neon/ansible]
         (vec (rest (workflow/wire-fn :neon/ssh-config {:green/event :create})))))
  (is (= [:neon/acceptance]
         (vec (rest (workflow/wire-fn :neon/ansible {:green/event :create}))))))

(deftest delete-removes-the-key-after-the-compute-destroy
  ;; The ordering is what makes "key present ⇔ deployment exists" hold: a
  ;; failed destroy never reaches the cleanup step, and correctly leaves the
  ;; key that is still the only credential to whatever survived.
  (is (= [:neon/ansible]
         (vec (rest (workflow/wire-fn :neon/start {:green/event :delete})))))
  (is (= [:neon/ssh-cleanup]
         (vec (rest (workflow/wire-fn :neon/infrastructure {:green/event :delete})))))
  (is (empty? (rest (workflow/wire-fn :neon/ssh-cleanup {:green/event :delete})))))
