import { Program, 
         Idl, 
         web3, 
         AnchorProvider, 
         Wallet, 
         BN, 
         IdlTypes} from "@project-serum/anchor"
import * as token from "@solana/spl-token"
import idl from "../target/idl/tic_tac_toe.json"
import * as fs from "fs"
import promptSync from "prompt-sync"
import { sha256 } from "js-sha256"
import bs58 from "bs58"
import { Mint } from "@solana/spl-token"
import { isValidAddress,
         isValidNumber,
         Game } from "./helper"

//configurations
const connection = new web3.Connection(web3.clusterApiUrl("devnet"), "confirmed")
const programId = new web3.PublicKey("6kTBYbV3itwchJZmT5wzPoWHiwzFwB5zCoHJmuYdYcVX")

//for taking input
const prompter = promptSync()

function main() {
    if (process.argv.length != 3) {
      console.error("Invalid argument count")
      console.log("Usage: ts-node <PATH-TO-THIS-FILE> <PATH-TO-USER-KEYPAIR-FILE>")
      return
    }
    const filePath = process.argv[2]
    if (!fs.existsSync(filePath)) {
      console.error("The provided user keypair file path is invalid")
      return
    }
    const fileContent = fs.readFileSync(filePath, "utf-8")
    let userKeypair: web3.Keypair;
    try {
      const secretKey = Uint8Array.from(JSON.parse(fileContent) as number[])
      userKeypair = web3.Keypair.fromSecretKey(secretKey)
      console.log("User:", userKeypair.publicKey.toBase58())
    } catch (err) {
      console.error("Could not retrieve keypair from the provided file")
      console.log("Check that the file content is a valid keypair")
    }

    const provider = new AnchorProvider(connection, new Wallet(userKeypair), {})
    const program = new Program(idl as Idl, programId, provider)

    console.log("What would you like to do?")
    console.log("1.Start a new game\n2.Accept a game\n3.Resume a game")
    let input: string = prompter("")
    switch (input) {
      case "1":
        newGame(userKeypair.publicKey, program)
        break
      case "2":
        acceptGame(userKeypair.publicKey, program)
        break
      case "3":
        resumeGame(userKeypair.publicKey, program)
        break
      default:
        console.error("Invalid input...")
    }
}
main()

async function playGame(player: web3.PublicKey, game: web3.PublicKey, program: Program) {
  
  // declare variables to use through out playing
  let gameAccount: Game
  let playerIndex: number
  let currentPlayerIndex: number
  let row: number
  let column: number
  let input: string

  // fetch the current game data and determine user's index
  gameAccount = await program.account.game.fetch(game) as Game
  if (gameAccount.players[0].toBase58() === player.toBase58())
    playerIndex = 0
  else
    playerIndex = 1

  // play the game till completion
  while (true) {

    // print the current board
    console.log("----------------------------------")
    for (let index=0; index<3; ++index) {
      let row = gameAccount.board[index]
      console.log(`  ${row[0]?row[0].x?"X":"O":" "}  ||  ${row[1]?row[1].x?"X":"O":" "}  ||  ${row[2]?row[2].x?"X":"O":" "}`)
      console.log("----------------------------------")
    }

    let gameState = gameAccount.state
    // if game is complete, print loss/win/draw message & if the user is initiator, close the game account & return
    if (!gameState.turn) {
      if (gameState.over) {
        const winner: web3.PublicKey = gameState.over.winner
        if (winner.toBase58() === player.toBase58())
          console.log("$$$$ You won the game $$$$")
        else 
          console.log("You lost the game :(")
      } else {
        console.log("---- Game tied ----")
      }
      if (playerIndex === 0) {
        await sendCloseTxn(game, player, gameAccount.players[1], gameAccount.stakeMint, program)
      }
      return
    }

    // obtain the current player
    currentPlayerIndex = Number(gameState.turn.index)

    // if its user's turn, prompt for input
    if (currentPlayerIndex === playerIndex) {
      let spaceIndex: number
      while (true) {
        input = prompter("Enter row & column to place your mark(space separated): ").trim()
        spaceIndex = input.indexOf(" ")
        if (spaceIndex === -1) {
          console.error("Please enter space separated values for row and column")
          continue
        }
        if (!isValidNumber(input.substring(0, spaceIndex))) {
          console.error("Your provided input is not numeric...")
          continue
        }
        row = Number(input.substring(0, spaceIndex))
        if (!isValidNumber(input.substring(spaceIndex+1, input.length).trim())) {
          console.error("Your provided input is invalid...")
          continue
        }
        column = Number(input.substring(spaceIndex+1, input.length).trim())
        if (row<0 || row>3 || column<0 || column>3) {
          console.error("The provided input is out of bounds for 3x3 board...")
          continue
        }
        if (gameAccount.board[row][column]) {
          console.error("The specified tile is already occupied...")
          continue
        }
        await sendPlayTxn(player, game, { row, column }, program)
        gameAccount = await program.account.game.fetch(game) as Game
        break
      }
    } else {

      // if not user's turn, wait for the other player's input
      console.log("Waiting for other player's move...")
      while (true) {
        await new Promise(f => setTimeout(f, 2000))
        gameAccount = await program.account.game.fetch(game) as Game
        gameState = gameAccount.state
        if (!gameState.turn)
          break
        if (playerIndex == Number(gameState.turn.index))
          break
      }
    }
  }
}

async function newGame(player: web3.PublicKey, program: Program) {

  // get user inputs for creating a new game
  const playerTwoAddr = prompter("Enter the address of player 2: ")
  const mintAddr = prompter("Enter the mint address of token to stake: ")
  if (!isValidAddress(playerTwoAddr)) {
    console.error("Player address provided is not a valid address...")
    return
  }
  if (!isValidAddress(mintAddr)) {
    console.error("Mint address provided is not a valid address...")
    return
  }
  if (player.toBase58() === playerTwoAddr) {
    console.error("Both the players in a game can not be same...")
    return
  }
  const playerTwo = new web3.PublicKey(playerTwoAddr)
  const mint = new web3.PublicKey(mintAddr)

  // fetch the mint details of the specified token
  let mintInfo: token.Mint
  try {
    mintInfo = await token.getMint(connection, mint)
    console.log("Total supply of token:", Number(mintInfo.supply)/(10**mintInfo.decimals))
    console.log("Smallest denomination:", 1/(10**mintInfo.decimals))
  } catch (err) {
    console.error("Error fetching token mint. The address provided might not be a mint...")
    return
  }

  // fetch all the token accounts of the user having the specified mint
  const response = await connection.getTokenAccountsByOwner(player, {mint})
  if (response.value.length === 0) {
    console.error("You do not have any token account with the specified mint...")
    return
  }

  // filter for accounts having non-zero amount
  const initialAccounts = response.value
  let tokenAccounts: { pubkey: web3.PublicKey,
                       account: token.RawAccount 
                     }[] = []
  for (let index=0; index<initialAccounts.length; ++index) {
    let tokenAccount = token.AccountLayout.decode(initialAccounts[index].account.data)
    if (tokenAccount.amount > 0) 
      tokenAccounts.push({ pubkey: initialAccounts[index].pubkey,
                           account: tokenAccount 
                         })
  }
  if (tokenAccounts.length == 0) {
    console.error("You do not have any tokens for the specified mint...")
    return
  }

  // prompt user to select one token account to transfer tokens for staking
  let selectedAccount: { pubkey: web3.PublicKey,
                         account: token.RawAccount 
                       }
  if (tokenAccounts.length === 1) {
    selectedAccount = tokenAccounts[0]
    console.log("Token account address:", selectedAccount.pubkey.toBase58())
    console.log("Token balance:", Number(selectedAccount.account.amount)/(10 ** mintInfo.decimals))
  } else {
    const divisor = 10 ** mintInfo.decimals
    tokenAccounts.forEach((ele, index) => {
      console.log(`${index+1}. Account: ${ele.pubkey.toBase58()}, Balance: ${Number(ele.account.amount)/divisor}`)
    })
    const choice: string = prompter("Choose the token account for staking")
    try {
      selectedAccount = tokenAccounts[parseInt(choice)-1]
    } catch (err) {
      console.error("Invalid token acccount selected...")
      return
    }
  
  }

  // prompt user to enter the amount of tokens to stake
  const stakeAmountInput =  prompter("Enter the amount of tokens to stake: ")
  if (!isValidNumber(stakeAmountInput)) {
    console.error("The value entered is not a valid number...")
    return
  }
  if (stakeAmountInput.includes(".")) {
    const decimalPlaces = stakeAmountInput.trim().split(".")[1].length
    if (decimalPlaces>0 && decimalPlaces>mintInfo.decimals) {
      console.error(`Your input has ${decimalPlaces} decimals, where maximum decimals allowed = ${mintInfo.decimals}`)
      return
    }
  }
  const stakeAmount = parseFloat(stakeAmountInput) * (10 ** mintInfo.decimals)
  if (stakeAmount === 0) {
    console.error("The amount of tokens to be staked must be greater than zero...")
    return
  }
  if (stakeAmount > selectedAccount.account.amount) {
    console.error("The amount of stake tokens specified exceeds the token account balance...")
    return
  }

  // send transaction to initialize (create) a new game
  const initializedGame = await sendInitializeTxn(selectedAccount, stakeAmount, playerTwo, program)

  // wait for player2 to accept the newly initialized game
  console.log("Waiting for opponent to accept the game...")
  let gameAccount
  while (true) {
    await new Promise(f => setTimeout(f, 2000))
    gameAccount = await program.account.game.fetch(initializedGame)
    if (JSON.stringify(gameAccount.state).includes("unaccepted"))
      continue
    break
  }

  // start playing the game
  await playGame(player, initializedGame, program)

}

async function acceptGame(player: web3.PublicKey, program: Program) {
  
  // fetch all games waiting for user's acceptance (& store in userGames array)
  const gameDiscriminator = Buffer.from(sha256.digest("account:Game")).subarray(0, 8)
  const games = await connection.getProgramAccounts(programId,
    {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: bs58.encode(gameDiscriminator)
          }
        }
      ]
    })

  let userGames = []
  for (let index=0; index<games.length; ++index) {
    let game = await program.account.game.fetch(games[index].pubkey)
    if (game.players[1].toBase58() === player.toBase58() && JSON.stringify(game.state) === '{"unaccepted":{}}')
      userGames.push({ pubkey: games[index].pubkey, 
                       data: game })
  }
  if (userGames.length === 0) {
    console.error("You have no games to accept, check that your opponent has initiated a game...")
    return
  }

  // prompt user to choose one game for accepting
  let selectedGame
  let mintInfo: Mint
  if (userGames.length === 1) {
    const userGame = userGames[0]
    mintInfo = await token.getMint(connection, userGame.data.stakeMint)
    console.log("You have one game to accept")
    console.log("Address:", userGame.pubkey.toBase58())
    console.log("Opponent:", userGame.data.players[0].toBase58())
    console.log("Stake token:", mintInfo.address.toBase58())
    console.log("Stake amount:", Number(userGame.data.stakeAmount)/(10 ** mintInfo.decimals))
    let input = prompter("\nWill you accept this game?(y/n): ")
    switch (input.toLowerCase()) {
      case "y":
        selectedGame = userGame
        break
      case "n":
        console.log("Exiting...")
        return
      default:
        console.error("Invalid input...")
        return
    }
  } else {
    console.log("Games waiting for your acceptance")
    for (let index=0; index<userGames.length; ++index) {
      let userGame = userGames[index]
      mintInfo = await token.getMint(connection, userGame.data.stakeMint)
      console.log("Game", index+1)
      console.log("Address:", userGame.pubkey.toBase58())
      console.log("Opponent:", userGame.data.players[0].toBase58())
      console.log("Stake token:", mintInfo.address.toBase58())
      console.log("Stake amount:", Number(userGame.data.stakeAmount)/(10 ** mintInfo.decimals))
      console.log("----------------------------------")
    }
    let input = prompter("\nEnter game number to accept: ")
    if (!isValidNumber(input)) {
      console.error("Entered input is not a valid number...")
      return
    }
    const gamePosition = Number(input)
    if (gamePosition == 0 || gamePosition > userGames.length) {
      console.error("Invalid input...")
      return
    }
    const selectedGame = userGames[gamePosition-1]
    mintInfo = await token.getMint(connection, selectedGame.stakeMint)
  }

  // fetch player's all the token accounts for the stake mint, with sufficient balance to stake
  const response = await connection.getTokenAccountsByOwner(player, {mint: selectedGame.data.stakeMint})
  if (response.value.length === 0) {
    console.error("You do not have any token account with the specified mint...")
    return
  }
  const accountsWithBalance = []
  response.value.forEach((acc) => {
    const tokenAccount = token.AccountLayout.decode(acc.account.data)
    if (tokenAccount.amount >= selectedGame.data.stakeAmount)
      accountsWithBalance.push({
        pubkey: acc.pubkey,
        tokenAccount
      })
  })
  if (accountsWithBalance.length === 0) {
    console.error("You do not have any token account with sufficient funds to stake...")
    return
  }

  // prompt user to select one of their token accounts for sending stake tokens
  let selectedAccount: { pubkey: web3.PublicKey,
                         tokenAccount: token.RawAccount
                       }
  if (accountsWithBalance.length === 1) {
      selectedAccount = accountsWithBalance[0]
      console.log("Token account address:", selectedAccount.pubkey.toBase58())
      console.log("Token balance:", Number(selectedAccount.tokenAccount.amount)/(10 ** mintInfo.decimals))

  } else {
    const divisor = 10 ** mintInfo.decimals
    accountsWithBalance.forEach((ele, index) => {
      console.log(`${index+1}. Account: ${ele.pubkey.toBase58()}, Balance: ${Number(ele.tokenAccount.amount)/divisor}`)
    })
    const choice: string = prompter("Choose the token account for staking")
    if (!isValidNumber(choice)) {
      console.error("Input entered is not a valid number...")
      return
    }
    try {
      selectedAccount = accountsWithBalance[parseInt(choice)-1]
    } catch (err) {
      console.error("Invalid token acccount selected...")
      return
    }
  }
  
  // send transaction to accept the game
  await sendAcceptTxn(selectedGame.pubkey, selectedAccount, program)

  // start playing the accepted game
  await playGame(player, selectedGame.pubkey, program)
}

async function resumeGame(player: web3.PublicKey, program: Program) {

  // fetch all the ongoing games where user is a player (& store in userGames array)
  const gameDiscriminator = Buffer.from(sha256.digest("account:Game")).subarray(0, 8)
  const games = await connection.getProgramAccounts(programId,
    {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: bs58.encode(gameDiscriminator)
          }
        }
      ]
    })

  let userGames = []
  for (let index=0; index<games.length; ++index) {
    let game = await program.account.game.fetch(games[index].pubkey)
    if ((game.players[0].toBase58() === player.toBase58() || game.players[1].toBase58() === player.toBase58()) && JSON.stringify(game.state).includes("turn"))
      userGames.push({ pubkey: games[index].pubkey, 
                       data: game })
  }
  if (userGames.length === 0) {
    console.error("You have no ongoing games at the moment...")
    return
  }

  // prompt user to select one game to resume
  let selectedGame
  if (userGames.length === 1) {
    selectedGame = userGames[0]
    const mintInfo = await token.getMint(connection, selectedGame.data.stakeMint)
    console.log("One ongoing game found")
    console.log("Address:", selectedGame.pubkey.toBase58())
    if (selectedGame.data.players[0].toBase58() === player.toBase58()) {
      console.log("Opponent:", selectedGame.data.players[1].toBase58())
    } else {
      console.log("Opponent:", selectedGame.data.players[0].toBase58())
    }
    console.log(`Staked tokens: ${Number(selectedGame.data.stakeAmount)/(10 ** mintInfo.decimals)} of ${selectedGame.data.stakeMint.toBase58()}`)
    let turnsRemaining = 0
    selectedGame.data.board.forEach((row) => {
      row.forEach((tile) => {
        if (!tile) 
          turnsRemaining += 1
      })
    })
    console.log("Turns remaining:", turnsRemaining)
  } else {
    console.log("Your ongoing games")
    for (let index=0; index<userGames.length; ++index) {
      const game = userGames[index]
      const mintInfo = await token.getMint(connection, game.data.stakeMint)
      console.log("Game ", index+1)
      console.log("Address:", game.pubkey.toBase58())
      if (game.data.players[0].toBase58() === player.toBase58()) {
        console.log("Opponent:", game.data.players[1].toBase58())
      } else {
        console.log("Opponent:", game.data.players[0].toBase58())
      }
      console.log(`Staked tokens: ${Number(game.data.stakeAmount)/(10 ** mintInfo.decimals)} of ${game.data.stakeMint.toBase58()}`)
      let turnsRemaining = 0
      game.data.board.forEach((row) => {
      row.forEach((tile) => {
        if (tile) 
          turnsRemaining += 1
        })
      })
      console.log("Turns remaining:", turnsRemaining)
      console.log("----------------------------------")
    }
    const gamePosition = prompter("\nWhich game would you like to resume?: ")
    if (!isValidNumber(gamePosition)) {
      console.error("The provided input is not a number...")
      return
    }
    const gamePositionNum = Number(gamePosition)
    if (gamePositionNum==0 || gamePositionNum>userGames.length) {
      console.error("Invalid input provided...")
      return
    }
    selectedGame = userGames[gamePositionNum-1]
  }

  // play the game selected by user
  await playGame(player, selectedGame.pubkey, program)
}

async function sendInitializeTxn(selectedAccount: { pubkey: web3.PublicKey,
                                                        account: token.RawAccount 
                                                      },
                                    stakeAmount: number,
                                    playerTwo: web3.PublicKey,
                                    program: Program): Promise<web3.PublicKey> {
  const gameKeypair = web3.Keypair.generate()
  const gameAddr = gameKeypair.publicKey
  const [authority] = web3.PublicKey.findProgramAddressSync([Buffer.from("authority")], programId)
  const stakeTokenAccount = token.getAssociatedTokenAddressSync(selectedAccount.account.mint, authority, true)
  const txn = await program.methods.initialize(new BN(stakeAmount))
                                      .accounts({
                                                  playerOne: selectedAccount.account.owner,
                                                  playerTwo,
                                                  game: gameAddr,
                                                  authority,
                                                  stakeMint: selectedAccount.account.mint,
                                                  stakeTokenAccount,
                                                  tokenAccount: selectedAccount.pubkey,
                                                })
                                      .signers([gameKeypair])
                                      .rpc()
  console.log("Created game account with address", gameAddr.toBase58())
  console.log(`https://explorer.solana.com/tx/${txn}?cluster=devnet`)
  const game = await program.account.game.fetch(gameAddr)
  console.log(game)
  return gameAddr                        
}

async function sendAcceptTxn(selectedGame: web3.PublicKey, 
                            selectedAccount: { pubkey: web3.PublicKey,
                                               tokenAccount: token.RawAccount
                                             },
                            program: Program) {
  const [authority] = web3.PublicKey.findProgramAddressSync([Buffer.from("authority")], programId)
  const stakeTokenAccount = token.getAssociatedTokenAddressSync(selectedAccount.tokenAccount.mint, authority, true)
  const txn = await program.methods.accept()
                             .accounts({
                                playerTwo: selectedAccount.tokenAccount.owner,
                                authority,
                                stakeMint: selectedAccount.tokenAccount.mint,
                                stakeTokenAccount,
                                tokenAccount: selectedAccount.pubkey,
                                game: selectedGame
                              })
                              .rpc()
  console.log(`https://explorer.solana.com/tx/${txn}?cluster=devnet`)
  const gameAccount = await program.account.game.fetch(selectedGame)
  console.log(gameAccount)
}

async function sendPlayTxn(player: web3.PublicKey, 
                           game: web3.PublicKey, 
                           tile: { row: number,
                                    column: number 
                                 },
                           program: Program) {
  const txn = await program.methods.play(new BN(tile.row), new BN(tile.column))
                      .accounts({
                        player,
                        game
                      })
                      .rpc()
  console.log(`https://explorer.solana.com/tx/${txn}?cluster=devnet`)
}

async function sendCloseTxn(game: web3.PublicKey, 
                            playerOne: web3.PublicKey, 
                            playerTwo: web3.PublicKey, 
                            stakeMint: web3.PublicKey, 
                            program: Program) {
  const [authority] = web3.PublicKey.findProgramAddressSync([Buffer.from("authority")], programId)
  const stakeTokenAccount = token.getAssociatedTokenAddressSync(stakeMint, authority, true)

  const playerOneAccounts = await connection.getTokenAccountsByOwner(playerOne, { mint: stakeMint })
  if (playerOneAccounts.value.length === 0) {
    console.error("Could not fetch any token account for player one...")
    return
  }
  const playerTwoAccounts = await connection.getTokenAccountsByOwner(playerTwo, { mint: stakeMint })
  if (playerTwoAccounts.value.length === 0) {
    console.error("Could not fetch any token accounts for player two...")
    return
  }

  const txn = await program.methods.close()
                      .accounts({
                        game,
                        playerOne,
                        playerTwo,
                        authority,
                        stakeMint,
                        stakeTokenAccount,
                        tokenAccountOne: playerOneAccounts.value[0].pubkey,
                        tokenAccountTwo: playerTwoAccounts.value[0].pubkey,
                      })
                      .rpc()
  console.log(`https://explorer.solana.com/tx/${txn}?cluster=devnet`)
}