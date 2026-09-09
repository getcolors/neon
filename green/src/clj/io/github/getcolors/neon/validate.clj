(ns io.github.getcolors.neon.validate
  (:require [io.github.getcolors.compute-planning :as planning] [io.github.getcolors.compute :as library] [io.github.getcolors.neon.compute :as compute] [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.validate :as once-validate]))

(def profile-par (green-cli/par-name :profile))

(def required
  "Every key desired state must carry.

  Two deliberate absences. `vultr-ssh-keys` selects opt-out mode by being
  present (SSH Keypair Standard), so requiring it would make every conforming
  keygen deployment invalid. `vultr-name` is the Compute Name Standard's
  optional override: a fresh colors.yml that omits it is complete and names
  the machine after the profile. There is likewise no `provider-dns`: nothing
  in this package is reachable by name — the firewall opens 22 only and the
  client path is an SSH tunnel — so a DNS provider would be a key with
  nothing to configure."
  [:profile :workdir :provider-compute :provider-backend
   :compute-prevent-destroy
   :neon-image :neon-compute-image :neon-pg-version
   :neon-tenant-id :neon-timeline-id
   :neon-database :neon-role
   :neon-r2-bucket :neon-r2-endpoint :neon-r2-region
])

(def image-keys [:neon-image :neon-compute-image])

;; `tag@sha256:...` — the shape both image keys actually carry — pins both the
;; human-readable release and the exact bytes. Upstream also publishes floating
;; tags, which is why the digest is required rather than the suffix denied.
(def image-re #"^[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64}|:[^\s:@]+@sha256:[0-9a-f]{64})$")
(def hex32-re #"^[0-9a-f]{32}$")
(def ident-re #"^[a-z_][a-z0-9_]*$")
(def url-re #"^https://[^\s]+$")

(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))

(defn placeholder?
  "Whether the compute-name override is effectively absent (Compute Name
  Standard §2: presence is the only switch)."
  [v]
  (or (missing? v) (= "REPLACE_ME" (str/trim (str v)))))

(defn compute-name
  "What this deployment calls its machine. The one function that answers it —
  every label, including the firewall's, derives from this and never from the
  raw override key or a second copy of the profile (§3)."
  [opts]
  (get-in (planning/plan-deployment opts compute/topology (compute/requirements opts)) [:cluster :nodes 0 :name]))

(defn keygen?
  "Whether this deployment owns its machine keypair. Delegates to ONCE, the
  standard's reference implementation, so one rule decides it everywhere."
  [opts]
  (= "managed" (get-in (planning/plan-deployment opts compute/topology (compute/requirements opts)) [:key :mode])))

(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(defn state-errors [opts]
  (vec
   (concat
    (for [k required :when (missing? (get opts k))] (str k " is required"))
    (compute/errors opts)
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])
    (for [k image-keys
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches image-re (str v))))]
      (str k " must carry an explicit image tag or digest"))
    ;; Upstream also publishes floating tags, and the two release trains move
    ;; independently, so the one thing that can be checked is that neither
    ;; floats: a digest is required, not merely a tag.
    (for [k image-keys
          :let [v (str (get opts k))]
          :when (and (not (missing? (get opts k)))
                     (not (str/includes? v "@sha256:")))]
      (str k " must be pinned by digest (tag@sha256:...)"))
    (when-not (or (missing? (:neon-pg-version opts))
                  (contains? #{14 15 16 17} (:neon-pg-version opts)))
      [":neon-pg-version must be 14, 15, 16, or 17"])
    ;; Tenant and timeline identities are desired state: fixing them is what
    ;; makes convergence reconcilable and recovery describable. Pageserver ids
    ;; are 16-byte hex strings.
    (for [k [:neon-tenant-id :neon-timeline-id]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches hex32-re (str v))))]
      (str k " must be 32 lowercase hex characters"))
    (for [k [:neon-database :neon-role]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches ident-re (str v))))]
      (str k " must be a lowercase identifier"))
    ;; cloud_admin is the superuser compute_ctl itself connects as; a desired
    ;; state that names it would collide with the generated credential.
    (when (= "cloud_admin" (str (:neon-role opts)))
      [":neon-role must not be cloud_admin"])
    (when-not (or (missing? (:neon-r2-endpoint opts))
                  (re-matches url-re (str (:neon-r2-endpoint opts))))
      [":neon-r2-endpoint must be an https URL"])
)))

(defn backend-secrets [opts]
  (:secrets (get-in library/registry
                    [:backend (keyword (:provider-backend opts))])))

(def provider-secrets
  "What talking to the provider needs, on any real event."
  [])

(def application-secrets
  "What converging the machine needs, and therefore only a create: the R2 pair
  the pageserver and safekeeper write remote storage with. The database role
  passwords are deliberately absent — they are generated on the server, once,
  and are never supplied by the operator."
  [:neon-r2-access-key-id :neon-r2-secret-access-key])

(defn secret-errors
  "Credentials a real event needs. A delete tears down infrastructure and never
  converges anything, so it asks for the provider credentials only."
  [opts event]
  (let [keys (concat provider-secrets
                     (when (= :create event) application-secrets)
                     (backend-secrets opts))]
    (for [k (distinct keys) :when (missing? (get opts k))]
      (str "required credential is not set: " (green-cli/par-name k)))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute {}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
