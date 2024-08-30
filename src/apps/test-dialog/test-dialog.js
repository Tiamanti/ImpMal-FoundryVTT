import log from "../../system/logger";
import ImpMalScript from "../../system/script";
import { DialogTooltips } from "./tooltips";

export class TestDialog extends Application
{

    static get defaultOptions() 
    {
        const options = super.defaultOptions;
        options.classes = options.classes.concat(["impmal", "test-dialog", "form"]);
        options.width = 500;
        options.resizable = true;
        return options;
    }

    #onKeyPress;
    selectedScripts = [];
    unselectedScripts = [];
    fieldsTemplate = "";
    
    get template() 
    {
        return `systems/impmal/templates/apps/test-dialog/test-dialog.hbs`;
    }

    get title() 
    {
        return this.data.title;
    }

    get actor() 
    {
        return ChatMessage.getSpeakerActor(this.data.speaker);
    }

    get context() 
    {
        return this.data.context;
    }


    // Backwards compatibility for scripts referencing adv/disCount
    get advCount()
    {
        return this.advantage;
    }

    set advCount(value)
    {
        this.advantage = value;
    }

    get disCount()
    {
        return this.disadvantage;
    }

    set disCount(value)
    {
        this.disadvantage = value;
    }

    constructor(data={}, fields={}, resolve, options={})
    {
        super(options);
        this.data = data;
        this.tooltips = new DialogTooltips();

        this.initialFields = mergeObject(this._defaultFields(), fields);
        this.fields = this._defaultFields();
        this.userEntry = {};

        // Keep count of sources of advantage and disadvantage
        this.advantage = 0;
        this.disadvantage = 0;
        this.forceState = undefined;
        // If the user specifies a state, use that

        // If an effect deems this dialog cannot be rolled, it can switch this property to true and the dialog will close
        this.abort = false;

        // The flags object is for scripts to use freely, but it's mostly intended for preventing duplicate effects
        // A specific object is needed as it must be cleared every render when scripts run again
        this.flags = {};

        Hooks.call("impmal:createRollDialog", this);
        data.scripts = data.scripts.concat(this._createScripts(this.options.scripts));

        if (resolve)
        {
            this.resolve = resolve;
        }
    }

    _defaultFields() 
    {
        return {
            modifier : 0,
            SL : 0,
            difficulty : "challenging",
            state : "none",
            rollMode : game.settings.get("core", "rollMode") || "publicroll"
        };
    }

    async _render(...args)
    {
        await super._render(args);
        
        if (this.abort)
        {
            this.close();
        }
    }

    async getData() 
    {
        // Reset values so they don't accumulate 
        this.tooltips.clear();
        this.flags = {};
        this.fields = this._defaultFields();
        this.advantage = 0;
        this.disadvantage = 0;

        
        this.tooltips.start(this);
        mergeObject(this.fields, this.initialFields);
        this.tooltips.finish(this, this.options.initialTooltip || "Initial");

        this.tooltips.start(this);
        for(let key in this.userEntry)
        {
            if (["string", "boolean"].includes(typeof this.userEntry[key]))
            {
                this.fields[key] = this.userEntry[key];
            }
            else if (Number.isNumeric(this.userEntry[key]))
            {
                this.fields[key] += this.userEntry[key];
            }
        }
        this.tooltips.finish(this, "User Entry");

        // For some reason cloning the scripts doesn't prevent isActive and isHidden from persisisting
        // So for now, just reset them manually
        this.data.scripts.forEach(script => 
        {
            script.isHidden = false;
            script.isActive = false;
        });
        
        this._hideScripts();
        this._activateScripts();
        await this.computeScripts();
        await this.computeFields();

        let state = this.computeState();

        return {
            scripts : this.data.scripts,
            fields : mergeObject(this.fields, {state}),
            advantage : this.advantage,
            disadvantage : this.disadvantage,
            tooltips : this.tooltips,
            subTemplate : await this.getFieldsTemplate()
        };
    }

    updateTargets()
    {
        if (!this.context.skipTargets)
        {
            this.data.targets = Array.from(game.user.targets);
        }
        this.render(true);
    }

    _hideScripts()
    {
        this.data.scripts.forEach((script, index) => 
        {
            // If user selected script, make sure it is not hidden, otherwise, run its script to determine
            if (this.selectedScripts.includes(index))
            {
                script.isHidden = false;
            }
            else
            {
                script.isHidden = script.hidden(this);
            }
        });
    }

    _activateScripts()
    {
        this.data.scripts.forEach((script, index) => 
        {
            // If user selected script, activate it, otherwise, run its script to determine
            if (this.selectedScripts.includes(index))
            {
                script.isActive = true;
            }
            else if (this.unselectedScripts.includes(index))
            {
                script.isActive = false;
            }
            else if (!script.isHidden) // Don't run hidden script's activation test
            {
                script.isActive = script.activated(this);
            }
        });
    }

    /**
     * Compute whether disadvantage or advantage should be selected
     */
    computeState()
    {
        if (this.forceState) //"adv" "dis" and "none"
        {
            return this.forceState;
        }

        else if (this.advantage > this.disadvantage && this.advantage > 0)
        {
            this.tooltips.start(this);
            this.fields.modifier += 10 * ((this.advantage - 1) - this.disadvantage);
            this.tooltips.finish(this, "Excess Advantage");
            return "adv";
        }

        else if (this.disadvantage > this.advantage && this.disadvantage > 0)
        {
            this.tooltips.start(this);
            this.fields.modifier -= 10 * ((this.disadvantage - 1) - this.advantage);
            this.tooltips.finish(this, "Excess Disadvantage");
            return "dis";

        }

        else 
        {
            return "none";
        }
    }

    /**
     * Handle relationships between fields, used by subclasses
     */
    async computeFields() 
    {

    }

    
    async computeScripts() 
    {
        for(let script of this.data.scripts)
        {
            if (script.isActive)
            {
                this.tooltips.start(this);
                await script.execute(this);
                this.tooltips.finish(this, script.Label);
            }
        }
    }

    _createScripts(scriptData = [])
    {
        return scriptData.map(i => new ImpMalScript(mergeObject(i, {
            options : {
                dialog : {
                    hideScript : i.hide, 
                    activateScript : i.activate, 
                    submissionScript : i.submit}}}),
        ImpMalScript.createContext(this.item instanceof Item ? this.item : this.actor)));
    }


    /**
     * Allows subclasses to insert custom fields
     */
    async getFieldsTemplate()
    {
        if (this.fieldsTemplate)
        {
            return await renderTemplate(this.fieldsTemplate, await this.getTemplateFields());
        }
    }

    /**
     * Provide data to a dialog's custom field section
     */
    async getTemplateFields() 
    {
        return {fields : this.fields};
    }

    submit(ev) 
    {
        ev.preventDefault();
        ev.stopPropagation();
        let dialogData = mergeObject(this.data, this.fields);
        dialogData.context.breakdown = this.tooltips.getBreakdown(this);

        for(let script of this.data.scripts)
        {
            if (script.isActive)
            {
                script.submission(this);
            }
        }

        if (this.resolve)
        {
            this.resolve(dialogData);
        }
        this.close();
        return dialogData;
    }


    async bypass()
    {
        await this.getData();
        let dialogData = mergeObject(this.data, this.fields);
        dialogData.context.breakdown = this.tooltips.getBreakdown(this);

        for(let script of this.data.scripts)
        {
            if (script.isActive)
            {
                script.submission(this);
            }
        }
        return dialogData;
    }

    close() 
    {
        super.close();
        document.removeEventListener("keypress", this.#onKeyPress);
    }

    activateListeners(html) 
    {
        this.form = html[0];
        this.form.onsubmit = this.submit.bind(this);

        // Listen on all elements with 'name' property
        html.find(Object.keys(new FormDataExtended(this.form).object).map(i => `[name='${i}']`).join(",")).change(this._onInputChanged.bind(this));

        html.find(".dialog-modifiers .modifier").click(this._onModifierClicked.bind(this));

        // Need to remember binded function to later remove
        this.#onKeyPress = this._onKeyPress.bind(this);
        document.addEventListener("keypress", this.#onKeyPress);
    }

    _onInputChanged(ev) 
    {
        let value = ev.currentTarget.value;
        if (Number.isNumeric(value))
        {
            value = Number(value);
        }

        if (ev.currentTarget.type == "checkbox")
        {
            value = ev.currentTarget.checked;
        }

        this.userEntry[ev.currentTarget.name] = value;

        // If the user clicks advantage or disadvantage, force that state to be true despite calculations
        if (ev.currentTarget.name == "state")
        {
            this.forceState = value;
        }
        this.render(true);
    }

    _onModifierClicked(ev)
    {
        let index = Number(ev.currentTarget.dataset.index);
        if (!ev.currentTarget.classList.contains("active"))
        {
            // If modifier was unselected by the user (originally activated via its script)
            // it can be assumed that the script will still be activated by its script
            if (this.unselectedScripts.includes(index))
            {
                this.unselectedScripts = this.unselectedScripts.filter(i => i != index);
            }
            else 
            {
                this.selectedScripts.push(index);
            }
        }
        else 
        {
            // If this modifier was NOT selected by the user, it was activated via its script
            // must be added to unselectedScripts instead
            if (!this.selectedScripts.includes(index))
            {
                this.unselectedScripts.push(index);
            }
            else // If unselecting manually selected modifier
            {
                this.selectedScripts = this.selectedScripts.filter(i => i != index);
            }
        }
        this.render(true);
    }

    _onKeyPress(ev)
    {
        if (ev.key == "Enter")
        {
            this.submit(ev); 
        }
    }

    /**
     * 
     * @param {object} data Dialog data, such as title and actor
     * @param {object} data.title.replace Custom dialog/test title
     * @param {object} data.title.append Append something to the test title
     * @param {object} fields Predefine dialog fields
     */
    static awaitSubmit({data={}, fields={}}={})
    {
        return new Promise(resolve => 
        {
            new this(data, fields, resolve).render(true);
        });
    }

    /**
     * 
     * @param {object} actor Actor performing the test
     * @param {object} data Dialog data, such as title and actor
     * @param {object} fields Predefine dialog fields
     */
    static setupData(actor, target, options={})
    {
        log(`${this.prototype.constructor.name} - Setup Dialog Data`, {args : Array.from(arguments).slice(2)});

        let dialogData = {data : {}, fields : options.fields || {}};
        if (actor)
        {
            dialogData.data.speaker = ChatMessage.getSpeaker({actor});
        }
        dialogData.data.context = options.context || {}; // Arbitrary values - used with scripts
        dialogData.data.context.tags = options.context?.tags || {}; // Tags shown below test results - used with scripts
        dialogData.data.context.text = options.context?.text || {}; // Longer text shown below test results - used with scripts
        dialogData.data.context.skipTargets = options.skipTargets;
        if (actor && !actor?.token)
        {
            // getSpeaker retrieves tokens even if this sheet isn't a token's sheet
            delete dialogData.data.speaker.scene;
        }
        dialogData.data.title = (options.title?.replace || game.i18n.localize("IMPMAL.Test")) + (options.title?.append || "");
        if (target)
        {
            dialogData.data.target = target;
        }

        dialogData.fields.difficulty = dialogData.fields.difficulty || "challenging";

        dialogData.data.targets = (actor?.defendingAgainst || options.skipTargets) ? [] : Array.from(game.user.targets).filter(t => t.document.id != dialogData.data.speaker.token); // Remove self from targets


        if (!options.skipTargets) 
        {
            // Collect Dialog effects 
            //   - Don't use our own targeter dialog effects, DO use targets' targeter dialog effects
            dialogData.data.scripts = foundry.utils.deepClone(
                (dialogData.data.targets
                    .map(t => t.actor)
                    .filter(actor => actor)
                    .reduce((prev, current) => prev.concat(current.getScripts("dialog", (s) => s.options.dialog?.targeter)), []) // Retrieve targets' targeter dialog effects
                    .concat(actor?.getScripts("dialog", (s) => !s.options.dialog?.targeter) // Don't use our own targeter dialog effects
                    ))) || [];
        }
        else 
        {
            dialogData.data.scripts = actor?.getScripts("dialog", (s) => !s.options.dialog?.targeter); // Don't use our own targeter dialog effects
        }


        log(`${this.prototype.constructor.name} - Dialog Data`, {args : dialogData});
        return dialogData;
    }

    static updateActiveDialogTargets() 
    {
        Object.values(ui.windows).forEach(i => 
        {
            if (i instanceof TestDialog)
            {
                i.updateTargets();
            }
        });
    }
}