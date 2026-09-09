(ns io.github.getcolors.neon.workflow
  (:require [clojure.walk :as walk]
            [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.neon.compute :as compute]
            [io.github.getcolors.neon.ssh-config :as ssh-config]
            [io.github.getcolors.neon.tools :as tools]
            [io.github.getcolors.neon.validate :as validate]))

(def defaults {:provider-compute "vultr"
               :provider-backend "r2" :compute-prevent-destroy true
               :workdir ".colors"})

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight
    opts {:defaults defaults :overlay green-cli/read-pars
          :validators
          [(fn [_ env _] (validate/env-errors env))
           (fn [opts _ _] (validate/state-errors opts))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (contains? #{:create :delete} event))
               (validate/secret-errors opts event)))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (= :delete event) (:compute-prevent-destroy opts))
               [(str "compute destruction is protected; set "
                     (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]
          :after-validate
          (fn [opts _ {:keys [event real?]}]
            (if (and real? (= :create event)) (ssh-config/preflight! (assoc opts :green/exit 0)) (assoc opts :green/exit 0)))} env)))

(defn wire-fn [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :neon/start [start-step :neon/load]
      :neon/load [compute/load-step :neon/ansible]
      :neon/ansible [tools/ansible-step :neon/ssh-config]
      ;; The `~/.ssh/config` block goes before the destroy, the opposite of the
      ;; keypair below. A block that outlives its host is stale but harmless; a
      ;; key that predeceases its host locks the operator out of a machine that
      ;; still exists. Both orders are deliberate; see standards/ssh-config.md.
      :neon/ssh-config [tools/ansible-local-step :neon/infrastructure]
      :neon/infrastructure [tools/infrastructure-step])
    (case step
      :neon/start [start-step :neon/infrastructure]
      ;; After compute, which is where the address first exists, and before the
      ;; stage that converges the machine — the converge and the acceptance
      ;; both ride the alias this stage writes.
      :neon/infrastructure [tools/infrastructure-step :neon/ssh-config]
      :neon/ssh-config [tools/ansible-local-step :neon/ansible]
      :neon/ansible [tools/ansible-step :neon/acceptance]
      :neon/acceptance [tools/acceptance-step])))

(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))

(def side-effecting
  [:neon/infrastructure :neon/ssh-config
   :neon/ansible :neon/acceptance :neon/load])

(def workflow
  (-> (wf/workflow {:start :neon/start :wire-fn wire-fn})
      progress/advise
      (dry-run/advise side-effecting)))
