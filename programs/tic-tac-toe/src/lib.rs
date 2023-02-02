/**
 * An onchain tic-tac-toe game
 * Any one of the players have to first call the initialize instruction to create a new game & stake their part of tokens
 * Player2 then has to accept the game and stake equal amount of same tokens
 * After a game has been initialized, players take turn in marking the tiles, with the player that initialized the game coming first
 * The game continues till either of the player wins or all of the board tiles are filled
 * Anyone can call the close instruction to send the tokens to the winner or return the tokens back in case of draw
 */
pub mod auxiliary;

use anchor_lang::prelude::*;
use auxiliary::*;
use anchor_spl::{token::{self, TokenAccount, Token, Mint, Transfer}, associated_token::AssociatedToken};

declare_id!("6kTBYbV3itwchJZmT5wzPoWHiwzFwB5zCoHJmuYdYcVX");

#[program]
pub mod tic_tac_toe {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, stake_amount: u64) -> Result<()> {
        require!(stake_amount>0, GameError::ZeroStakeAmount);
        let game = &mut ctx.accounts.game;
        game.players = [ctx.accounts.player_one.key(), ctx.accounts.player_two.key()];
        game.stake_mint = ctx.accounts.stake_mint.key();
        game.stake_amount = stake_amount;

        let cpi_context = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.token_account.to_account_info(),
                to: ctx.accounts.stake_token_account.to_account_info(),
                authority: ctx.accounts.player_one.to_account_info(),
            }
        );
        token::transfer(cpi_context, stake_amount)?;
        Ok(())
    }
    pub fn accept(ctx: Context<Accept>) -> Result<()> {
        let cpi_context = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.token_account.to_account_info(),
                to: ctx.accounts.stake_token_account.to_account_info(),
                authority: ctx.accounts.player_two.to_account_info(),
            }
        );
        token::transfer(cpi_context, ctx.accounts.game.stake_amount)?;
        ctx.accounts.game.state = State::Turn{index:0};
        Ok(())
    }
    pub fn play(ctx: Context<Play>, row: u8, col: u8) -> Result<()> {
        ctx.accounts.game.play(ctx.accounts.player.key(), row, col)
    }
    pub fn close(ctx: Context<Close>) -> Result<()> {
        macro_rules! transfer_context {
            ($receiver:ident) => {
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.stake_token_account.to_account_info(),
                        to: $receiver,
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                    &[&[b"authority".as_ref(), &[*ctx.bumps.get("authority").unwrap()]]]
                )
            };
        }
        let game = &ctx.accounts.game;
        match game.state {
            State::Draw => {
                let mut receiver = ctx.accounts.token_account_one.as_ref().unwrap().to_account_info();
                token::transfer(transfer_context!(receiver), game.stake_amount)?;
                receiver = ctx.accounts.token_account_two.as_ref().unwrap().to_account_info();
                token::transfer(transfer_context!(receiver), game.stake_amount)?;
            }
            State::Over { winner } => {
                let receiver = if winner==ctx.accounts.player_one.key() {
                    ctx.accounts.token_account_one.as_ref().unwrap().to_account_info()
                } else {
                    ctx.accounts.token_account_two.as_ref().unwrap().to_account_info()
                };
                token::transfer(transfer_context!(receiver), 2*game.stake_amount)?;
            }
            _ => return err!(GameError::GameNotCompleted),
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub player_one: Signer<'info>,
    /// CHECK: this account is not being read/written
    pub player_two: UncheckedAccount<'info>,
    #[account(init, payer=player_one, space=8+2*32+2*9+1+32+32+8)]
    pub game: Account<'info, Game>,
    /// CHECK: pda to act as owner of stake_token_account
    #[account(seeds=[b"authority"], bump)]
    pub authority: UncheckedAccount<'info>,
    pub stake_mint: Account<'info, Mint>,
    #[account(init_if_needed, payer=player_one, 
              associated_token::mint=stake_mint, 
              associated_token::authority=authority)]
    pub stake_token_account: Account<'info, TokenAccount>,
    #[account(mut, 
              token::mint=stake_mint,
              token::authority=player_one)]
    pub token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Accept<'info> {
    #[account(address=game.players[1] @ GameError::NotAuthorized)]
    pub player_two: Signer<'info>,
    /// CHECK: pda to act as owner of stake_token_account
    #[account(seeds=[b"authority"], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(address=game.stake_mint)]
    pub stake_mint: Account<'info, Mint>,
    #[account(mut, 
              associated_token::mint=stake_mint,
              associated_token::authority=authority)]
    pub stake_token_account: Account<'info, TokenAccount>,
    #[account(mut, 
              token::mint=stake_mint,
              token::authority=player_two)]
    pub token_account: Account<'info, TokenAccount>,
    #[account(mut,
              constraint= game.state==State::Unaccepted @ GameError::GameAlreadyAccepted)]
    pub game: Account<'info, Game>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Play<'info> {
    pub player: Signer<'info>,
    #[account(mut)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
pub struct Close<'info> {
    #[account(mut, close=player_one)]
    pub game: Account<'info, Game>,
    /// CHECK: address check is sufficient to validate
    #[account(address=game.players[0])]
    pub player_one: UncheckedAccount<'info>,
    /// CHECK: address check is sufficient to validate
    #[account(address=game.players[1])]
    pub player_two: Option<UncheckedAccount<'info>>,
    /// CHECK: pda to act as owner of stake_token_account
    #[account(seeds=[b"authority"], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(address=game.stake_mint)]
    pub stake_mint: Account<'info, Mint>,
    #[account(mut,
              associated_token::mint=stake_mint,
              associated_token::authority=authority)]
    pub stake_token_account: Account<'info, TokenAccount>,
    #[account(mut,
              token::mint=stake_mint,
              token::authority=player_one)]
    pub token_account_one: Option<Account<'info, TokenAccount>>,
    #[account(mut,
              token::mint=stake_mint,
              token::authority=player_two)]
    pub token_account_two: Option<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}