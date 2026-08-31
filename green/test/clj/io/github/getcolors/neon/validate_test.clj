(ns io.github.getcolors.neon.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [green.cli :as green-cli]
            [io.github.getcolors.neon.validate :as validate]))

(def fixture-file "test/fixtures/colors.yml")
(def optout-file "test/fixtures/optout.yml")

(defn- read-fixture [path overrides]
  (merge (green-cli/read-state path (str/replace (slurp path) "WORKDIR" ".colors"))
         overrides))
(defn fixture [& {:as overrides}] (read-fixture fixture-file overrides))
(defn optout [& {:as overrides}] (read-fixture optout-file overrides))

(deftest fixture-is-valid (is (= [] (validate/state-errors (fixture)))))

(deftest optout-fixture-is-valid (is (= [] (validate/state-errors (optout)))))

(deftest machine-key-is-not-required
  ;; The standard makes absence meaningful: requiring vultr-ssh-keys would make
  ;; every conforming deployment invalid.
  (is (not-any? #(str/includes? % "vultr-ssh-keys") (validate/state-errors (fixture)))))

(deftest absent-machine-key-selects-keygen
  (is (true? (validate/keygen? (fixture))))
  (is (false? (validate/keygen? (optout)))))

(deftest the-machine-is-named-after-the-profile
  ;; Compute Name Standard: no name key required, the profile is the name, and
  ;; the optional override wins only when it is genuinely present.
  (is (= "neon-fixture" (validate/compute-name (fixture))))
  (is (= "neon-fixture" (validate/compute-name (fixture :vultr-name "REPLACE_ME"))))
  (is (= "custom" (validate/compute-name (fixture :vultr-name "custom")))))

(deftest reports-all-errors
  (let [errors (validate/state-errors
                (fixture :neon-image "neondatabase/neon:latest"
                         :provider-compute "digitalocean"
                         :neon-pg-version 13
                         :neon-tenant-id "xyz"
                         :neon-role "Not-An-Identifier"
                         :neon-r2-endpoint "ftp://example"
                         :vultr-os-id "2284"))]
    (is (<= 6 (count errors)))
    (doseq [part ["digest" "vultr" "pg-version" "tenant-id" "role" "endpoint" "os-id"]]
      (is (some #(str/includes? % part) errors) part))))

(deftest accepts-a-digest-pin
  (is (= [] (validate/state-errors
             (fixture :neon-image
                      (str "ghcr.io/neondatabase/neon:release-9129@sha256:"
                           (apply str (repeat 64 "a"))))))))

(deftest the-images-may-not-float
  ;; Upstream publishes floating tags and the two release trains move
  ;; independently, so nothing can check the pair is compatible. What can be
  ;; checked is that neither moves on its own between converges: the digest
  ;; is required.
  (doseq [k [:neon-image :neon-compute-image]]
    (let [errors (validate/state-errors (fixture k "neondatabase/neon:release-9129"))]
      (is (some #(str/includes? % "digest") errors) (str k)))))

(deftest the-application-role-may-not-be-cloud-admin
  ;; cloud_admin is the superuser compute_ctl itself connects as; naming it
  ;; would collide with the generated credential.
  (let [errors (validate/state-errors (fixture :neon-role "cloud_admin"))]
    (is (some #(str/includes? % "cloud_admin") errors))))

(deftest tenant-and-timeline-are-32-hex
  (doseq [k [:neon-tenant-id :neon-timeline-id]]
    (is (some #(str/includes? % "hex")
              (validate/state-errors (fixture k "UPPERCASE-and-short"))) (str k))
    (is (= [] (validate/state-errors (fixture k (apply str (repeat 32 "b"))))))))

(deftest profile-overlay-is-refused
  (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "other"})))
  (is (nil? (validate/env-errors {}))))

(deftest a-create-names-every-package-secret
  (let [errors (str/join "\n" (validate/secret-errors (fixture) :create))]
    (doseq [name ["COLORS_PAR_VULTR_API_KEY"
                  "COLORS_PAR_NEON_R2_ACCESS_KEY_ID"
                  "COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? errors name) name))
    ;; The database role passwords are generated on the server and never
    ;; supplied by the operator; there is likewise no DNS provider to
    ;; credential.
    (is (not (str/includes? errors "PASSWORD")))
    (is (not (str/includes? errors "CLOUDFLARE")))))

(deftest a-delete-asks-only-for-the-providers
  ;; Destroying a machine must not require the credentials needed to converge
  ;; one; the R2 data pair should not be a lock on the exit.
  (let [errors (str/join "\n" (validate/secret-errors (fixture) :delete))]
    (is (str/includes? errors "COLORS_PAR_VULTR_API_KEY"))
    (is (not (str/includes? errors "COLORS_PAR_NEON_R2_ACCESS_KEY_ID")))))
